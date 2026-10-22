#!/usr/bin/env node
// The reliability bar for user mode: N user-mode trades on a stack, with the wallet closed
// mid-trade, the operator restarted and the parent chain held in a contest, every trade counted
// settled or cleanly returned with no user action, and the ticket checked against what moved.
// A pair and source reach user mode only when this drill passes for them
// (user-mode/pairs.json, with user-mode/REPORT.md beside it).
//
// Each wallet is a process of its own (user-mode-wallet.mjs) running the composer's engine, the
// code the page runs. A trade is the engine's quote and confirm; the drill then only moves the
// trade on (the engine's resume) and never acts for the person. Per trade it checks:
//   settled   the pay asset fell by exactly the ticket's amount in, and the receive asset rose by
//             exactly its amount out;
//   returned  nothing traded: the receive asset as before, the pay asset less only the fees the
//             return names (a take's payment to itself, spent before the take was voided);
//   failure   anything else, or neither within the drill's wait.
//
// Disruptions, by trade number (each counted in the report):
//   every --close-every trades   the wallet's process is killed (SIGKILL) once the trade is Sent,
//                                and started again 5 to 40 seconds later;
//   every --restart-every trades the operator is restarted while the trade is in flight;
//   every --contest-every trades once the trade's round is in a block, the parent chain is
//                                reorganised from that block's anchor (an anchor rollback): the
//                                round leaves the chain and must come back.
//
// Regtest (the operator repository's harness at its control address):
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd \
//     node tooling/user-mode-drill.mjs --trades 500 --wallets 3 --out DIR
// With --btc, on a harness started with ARCA_OPERATOR_LIGHTNING and ARCA_OPERATOR_BTC_LIGHTNING
// set to the number of wallets, BTC trades join: the maker's BTC desk runs on the harness's hub
// node and each wallet on a Bitcoin Lightning node of its own, and the trades cycle X for Y, Y for
// X, X for BTC and BTC for X (the operator's Lightning leg is in X).
//
// It writes DIR/REPORT.md, DIR/pairs.json (this chain's admitted pairs when every trade passed),
// DIR/trades.jsonl and the logs. Nothing here is used by the deployed wallet.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { harness, startRelay, placeOrder, restOrder, startMaker, launchMaker, makerReady, freePort, sleep, lwkFrom, relayBook } from './user-mode-stack.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv
const opt = (n, d) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : d }
const N = Number(opt('--trades', '500'))
const K = Number(opt('--wallets', '3'))
const out = resolve(opt('--out', join(process.cwd(), 'user-mode-drill')))
const CLOSE_EVERY = Number(opt('--close-every', '7'))
const RESTART_EVERY = Number(opt('--restart-every', '20'))
const CONTEST_EVERY = Number(opt('--contest-every', '25'))
const WAIT_MS = Number(opt('--wait-seconds', '900')) * 1000
const BTC = argv.includes('--btc')
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const SEQOBD = process.env.SEQOBD
if (!SEQOBD && !opt('--stack', null)) { console.error('SEQOBD must name the relay binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const logFile = join(out, 'drill.log'), tradesFile = join(out, 'trades.jsonl')
writeFileSync(logFile, ''); writeFileSync(tradesFile, '')
const T0 = Date.now()
const note = (s) => { s = `${((Date.now() - T0) / 1000).toFixed(0).padStart(6)}s ${s}`; console.log(s); appendFileSync(logFile, s + '\n') }
const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const H = harness(control)
const children = []
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

// ---- the wallets ----
function walletProc (i, cfgFile) {
  const dir = join(out, `wallet-${i}`); mkdirSync(dir, { recursive: true })
  const w = { i, dir, port: 0, proc: null, url: null, cfgFile, log: join(dir, 'wallet.log') }
  w.start = async () => {
    w.port = await freePort()
    w.proc = spawn(process.execPath, [join(here, 'user-mode-wallet.mjs'), '--dir', dir, '--port', String(w.port), '--config', cfgFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    w.proc.stdout.on('data', (d) => appendFileSync(w.log, d)); w.proc.stderr.on('data', (d) => appendFileSync(w.log, d))
    w.url = `http://127.0.0.1:${w.port}`
    for (let k = 0; k < 120; k++) { try { if ((await fetch(w.url + '/health')).ok) return } catch {} await sleep(500) }
    throw new Error(`wallet ${i} did not start`)
  }
  w.kill = () => new Promise((ok) => { if (!w.proc || w.proc.exitCode != null) return ok(); w.proc.once('exit', ok); w.proc.kill('SIGKILL') })
  w.call = async (path, body) => {
    for (let k = 0; ; k++) {
      try {
        const r = await fetch(w.url + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
        const j = await r.json()
        if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`)
        return j
      } catch (e) { if (k < 3 && /fetch failed|ECONNREFUSED/.test(String(e.message))) { await sleep(1000); continue } throw e }
    }
  }
  return w
}

// ---- the stack: the regtest harness, or the testnet from a configuration (--stack FILE) ----
const STACK = opt('--stack', null)

// The regtest stack: the harness's operator and chain, a relay and a maker of the drill's own,
// covenant orders it places, wallets it funds from the harness's purse, the operator's clock run by
// the drill (a round every 2 s), and every disruption forced.
async function regtestStack () {
  const st = await H.state()
  const X = st.x, Y = st.y
  if (BTC && !(st.btc_lightning && st.btc_lightning.wallets && st.btc_lightning.wallets.length >= K)) throw new Error(`--btc needs the harness's Bitcoin side with ${K} wallets' nodes (ARCA_OPERATOR_BTC_LIGHTNING)`)
  // BTC is quoted in satoshis: the maker gives a satoshi for 2.1 atoms of X, and 0.55 of one for an atom.
  const btcDesk = BTC ? { rpc: st.btc_lightning.hub, keep_sats: '200000', invoice_seconds: 3600,
    pairs: [{ give: 'BTC', want: X, rate_num: '21', rate_den: '10', min_give: '5000' }, { give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }] } : null
  const lwk = await lwkFrom()
  const relay = await startRelay(SEQOBD, st, await freePort()); children.push(relay.proc)
  note(`relay seqobd pid ${relay.proc.pid}`)
  // One live maker quoting both directions, holding both assets.
  const makerPairs = [{ give: Y, want: X, rate_num: '5', rate_den: '4', min_give: '10000' }, { give: X, want: Y, rate_num: '4', rate_den: '5', min_give: '10000' }]
  // A payment over Lightning needs an exit delay longer than the operator's two units for it.
  const exitUnits = BTC ? 3 : 1
  const maker = await startMaker(H, st, join(out, 'maker'), { pairs: makerPairs, fund: [[Y, 60000000], [X, 60000000]], port: await freePort(), lwk, settleSeconds: 20, syncSeconds: 3, coinSize: 2000000, exitDelayUnits: exitUnits, btc: btcDesk })
  children.push(maker.proc)
  note(`leaf maker pid ${maker.proc.pid}`)
  // Covenant orders both ways at prices a little better than the maker's but of little depth, so
  // a trade takes an order while one holds enough and goes to the maker otherwise: both sources
  // are drilled. Y for X at 6 X per 5 Y (the maker asks 5 per 4); X for Y at 3 Y per 4 X (the
  // maker asks 4 per 5).
  const RATES = { [`${Y}:${X}`]: [6, 5], [`${X}:${Y}`]: [3, 4] }
  const order = async (sell, want, amount) => { const [n, d] = RATES[`${sell}:${want}`]; return placeOrder(H, relay.url, { assetA: sell, assetB: want, sell: amount, rateNum: n, rateDen: d, minLot: 10000 }) }
  await order(Y, X, 1500000); await order(X, Y, 1500000)
  await makerReady(H, maker, Y); await makerReady(H, maker, X)
  // The operator fronts every coin a round refreshes from its own: give it enough to start.
  await H.c('/fund_server', { asset: X, amount: 200000000 }); await H.c('/fund_server', { asset: Y, amount: 200000000 }); await H.produce()
  const walletConfig = { operator: { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password },
    makers: [maker.url], relay: relay.url, genesis: st.genesis_hash, exit_delay_units: exitUnits }
  const btcRpcs = BTC ? st.btc_lightning.wallets : null
  // Each wallet holds ten coins of 3,000,000 of each asset, as a wallet funded a little at a time
  // does: what a trade leaves as change, and must settle in the next round, is then small.
  const COINS = 10, COIN = 3000000
  async function fund (wallets) {
    for (const w of wallets) {
      const a = await w.call('/run', { command: 'address' })
      // The harness's purse chains its payments: a block every few keeps the chain short.
      for (let k = 0; k < COINS; k++) { await H.fund(a.script_pubkey, X, COIN + 100000); await H.fund(a.script_pubkey, Y, COIN + 100000); if (k % 4 === 3) await H.produce() }
      for (let k = 0; k < 3; k++) await H.fund(a.script_pubkey, X, 1000000)
      await H.produce()
    }
    for (let k = 0; k < COINS; k++) {
      for (const asset of [X, Y]) {
        for (const w of wallets) {
          for (let t = 0; ; t++) {
            try {
              await w.call('/run', { command: 'sync' })
              // A board asked before may have gone through: count what is boarded first.
              const bal = await w.call('/run', { command: 'balance' })
              const boarded = Object.values((bal.arca || {})[asset] || {}).reduce((n, v) => n + big(v), 0n)
              if (boarded >= BigInt(COIN) * BigInt(k + 1)) break
              const q = await w.call('/run', { command: 'board_quote', args: { asset, amount: String(COIN), fee_asset: X } })
              await w.call('/run', { command: 'board', args: { asset, amount: String(COIN), fee_asset: X, shown: q.fee } })
              break
            } catch (e) { if (t > 20) throw e; await H.produce(); await sleep(1000) }
          }
        }
        await H.produce()
      }
    }
    await H.produce(); await H.bury()
    for (const w of wallets) await w.call('/run', { command: 'sync' })
    note(`wallets ${wallets.map((w) => w.proc.pid).join(', ')} hold ${COINS} coins of ${COIN} of X and of Y each`)
  }
  // A maker who rests orders in the tree and goes away: a wallet of the stack's own, funded as the
  // drill's wallets are, resting an order of 2,500,000 each way, listed on the relay, and rested
  // again whenever one holds less than 600,000. Y for X at 47 X per 40 Y, the best price that way
  // (the covenant order asks 6 per 5, the maker 5 per 4); X for Y at 31 Y per 40 X, between the
  // covenant order (3 per 4) and the maker (4 per 5): so every source leads one way or the other.
  const RESTING = { [`${Y}:${X}`]: [47, 40], [`${X}:${Y}`]: [31, 40] }
  let rester = null
  const rest = async (sell, want) => { const [n, d] = RESTING[`${sell}:${want}`]; const id = await restOrder(H, rester, relay.url, { assetA: sell, assetB: want, sell: 2500000, rateNum: n, rateDen: d, minLot: 10000 }); note(`rested an order of 2,500,000 ${sell === X ? 'X' : 'Y'} in the tree (${id.slice(0, 12)}), listed on the relay`) }
  async function prepare () {
    const cfgFile = join(out, 'wallet-config-rester.json')
    writeFileSync(cfgFile, JSON.stringify({ ...walletConfig, pairs_file: join(out, 'pairs-run.json') }), { mode: 0o600 })
    rester = walletProc('rester', cfgFile); await rester.start(); children.push({ kill: () => rester.kill() })
    await fund([rester])
    await rest(Y, X); await rest(X, Y)
  }
  async function topUp () {
    // The operator pays a round's makers and fronts every refresh from its own coins: the drill
    // keeps them topped up, as an operator does, and keeps the covenant book stocked and the
    // maker funded.
    try { await H.c('/fund_server', { asset: X, amount: 200000000 }); await H.c('/fund_server', { asset: Y, amount: 200000000 }); await H.produce() } catch (e) { note('top-up: ' + e.message) }
    const book = relayBook(relay.url)
    for (const [sell, want] of [[Y, X], [X, Y]]) {
      const offers = await book(want, sell).catch(() => [])
      const active = offers.filter((o) => o.covenant && o.offer_asset === sell).reduce((n, o) => n + big(o._status && o._status.active_amount), 0n)
      if (active < 400000n) { await order(sell, want, 1500000); note(`stocked a covenant order of 1,500,000 ${sell === X ? 'X' : 'Y'}`) }
      const resting = offers.filter((o) => o.resting_leaf && o.offer_asset === sell).reduce((n, o) => n + big(o._status && o._status.active_amount), 0n)
      if (rester && resting < 600000n) { try { await rest(sell, want) } catch (e) { note('rest: ' + e.message) } }
    }
    try { const a = await (await fetch(maker.url + '/v1/quotes')).json(); for (const q of a.quotes || []) if (big(q.max_give) < 3000000n) { const sc = await H.scriptOf(maker.address); await H.fund(sc, q.give_asset, 20000000); await H.produce(); note('funded the maker 20,000,000 ' + (q.give_asset === X ? 'X' : 'Y')) } } catch {}
  }
  let stop = false
  const pumpLoop = (async () => { while (!stop) { try { await H.pump() } catch (e) { note('pump: ' + e.message) } await sleep(2000) } })()
  return {
    kind: 'regtest', genesis: st.genesis_hash, X, Y, names: { [X]: 'X', [Y]: 'Y', BTC: 'BTC' }, walletConfig, fund, prepare, topUp, btcRpcs,
    amount: (pay) => (pay === 'BTC' ? rand(25000, 190000) : rand(50000, 400000)),
    restart: async () => { await H.restart() },
    // The round of a trade, once it is in a block: the parent chain reorganised from that block's
    // anchor, so the round leaves the chain and must come back.
    contest: async (round) => {
      const tx = await H.rpc('getrawtransaction', [round, true]).catch(() => null)
      if (!tx || !tx.blockhash) return null
      const hdr = await H.rpc('getblockheader', [tx.blockhash, true])
      const o = await H.orphan(hdr.anchorheight)
      return `parent chain reorganised from anchor ${hdr.anchorheight} (${o.orphaned} parent blocks) under round ${round.slice(0, 12)}`
    },
    stop: async () => { stop = true; await pumpLoop },
    logs: () => { writeFileSync(join(out, 'seqobd.log'), relay.log.join('')); writeFileSync(join(out, 'maker.log'), maker.log.join('')) },
    describe: [
      `- Chain: \`${st.genesis_hash}\` (regtest, the operator repository's harness \`arca_operator_for_browsers\`, anchored proof of stake).`,
      '- The operator, rounds built every 2 s by the drill\'s clock, leaves with an exit delay of one 512 s unit (the one difference from the testnet\'s shape); SeqDEX\'s relay with `-fill-anchor-depth=2`; one live leaf maker (`tooling/lsp/leaf-maker.mjs`) quoting both directions from coins of 2,000,000; transparent covenant orders both ways, priced a little better than the maker and of little depth, restocked every 25 trades.',
      `- ${K} wallets, one trade at a time each, amounts between 50,000 and 400,000 atoms${BTC ? ' (25,000 to 190,000 sat when BTC is paid)' : ''}, the direction ${BTC ? 'cycling X for Y, Y for X, X for BTC and BTC for X' : 'alternating'}; each wallet starts with ten coins of 3,000,000 of each asset.`,
      ...(BTC ? ['- BTC over Lightning on a Bitcoin regtest chain beside the harness: the maker\'s desk on a hub node with a channel of 10,000,000 sat to each wallet\'s own node, half of it the wallet\'s; the operator\'s Lightning leg in X (SeqLN, the hold-invoice plugin), its payments out of the tree timing out four to eight days out; the wallets\' and the maker\'s exit delay three units.'] : []),
      '- A maker who rests an order of 2,500,000 each way in the operator\'s tree and goes away (`order_rest`, listed on the relay with its `resting_leaf` member), the best price for Y and between the covenant order and the live maker for X, rested again whenever one holds less than 600,000.',
      '- The operator fronts, from its own coins, every coin a round settles: each in-tree trade settles both the coin it brings and the change, so the operator needs as much of each asset as the trades move until the old batches expire. The drill gives it 200,000,000 of each asset at the start and every 25 trades.',
    ],
  }
}

// The testnet stack, from a configuration the owner script writes on the server:
//   { operator: {server, node_url, node_user, node_password_file}, relay, makers: [url], genesis,
//     assets: { x: {id, ticker}, y: {id, ticker} }, fund_each: atoms of each asset per wallet,
//     amount: [least, most] atoms a trade pays, maker_pay: { command: [argv…] } (pays the wallets'
//     receive requests from the live maker's leaves; the requests' file is appended to argv),
//     restart: { command: [argv…], wait_url, max, locks: [paths] } }
// The operator runs its own rounds. The parent chain is not forced into a contest: the report
// counts the anchor reorganisations the trades met.
async function testnetStack (file) {
  const c = JSON.parse(readFileSync(file, 'utf8'))
  const X = c.assets.x.id, Y = c.assets.y.id
  const pw = readFileSync(c.operator.node_password_file, 'utf8').trim()
  const walletConfig = { operator: { server: c.operator.server, node_url: c.operator.node_url, node_user: c.operator.node_user, node_password: pw },
    makers: c.makers, relay: c.relay, genesis: c.genesis }
  let restarts = 0
  async function fund (wallets) {
    // Each wallet asks the live maker, which pays it in the tree from its own leaves.
    const reqs = []
    for (const w of wallets) for (const a of [X, Y]) reqs.push((await w.call('/run', { command: 'receive', args: { asset: a, amount: String(c.fund_each) } })).request)
    const reqFile = join(out, 'receive-requests.txt'); writeFileSync(reqFile, reqs.join('\n') + '\n', { mode: 0o600 })
    execFileSync(c.maker_pay.command[0], [...c.maker_pay.command.slice(1), reqFile], { stdio: 'inherit' })
    for (let k = 0; k < 60; k++) {
      let all = true
      for (const w of wallets) { await w.call('/run', { command: 'sync' }).catch(() => {}); const b = await w.call('/balance'); if (big(b.live[X]) < big(c.fund_each) || big(b.live[Y]) < big(c.fund_each)) all = false }
      if (all) break
      if (k === 59) throw new Error('the wallets were not paid what they asked the maker for')
      await sleep(10000)
    }
    note(`wallets ${wallets.map((w) => w.proc.pid).join(', ')} hold ${c.fund_each} of ${c.assets.x.ticker} and of ${c.assets.y.ticker} each, paid by the maker in the tree`)
  }
  const lockHeld = (p) => { try { execFileSync('flock', ['-n', p, 'true']); return false } catch { return existsSync(p) } }
  return {
    kind: 'testnet', genesis: c.genesis, X, Y, names: { [X]: c.assets.x.ticker, [Y]: c.assets.y.ticker }, walletConfig, fund, topUp: async () => {},
    amount: () => rand(Number(c.amount[0]), Number(c.amount[1])),
    restart: async () => {
      if (restarts >= (c.restart.max ?? 5)) throw new Error('the run has restarted the operator as often as it may')
      for (const l of c.restart.locks || []) if (lockHeld(l)) throw new Error(`another owner script holds ${l}: no restart now`)
      execFileSync(c.restart.command[0], c.restart.command.slice(1), { stdio: 'inherit' })
      restarts++
      for (let k = 0; k < 60; k++) { try { if ((await fetch(c.restart.wait_url, { signal: AbortSignal.timeout(5000) })).ok) return } catch {} await sleep(1000) }
      throw new Error('the operator did not answer within a minute of its restart')
    },
    contest: null,
    stop: async () => {},
    logs: () => {},
    describe: [
      `- Chain: \`${c.genesis}\` (the Sequentia testnet), the operator at ${c.operator.server} on its own clock and on the specification's delays, SeqDEX's relay at ${c.relay}, the live leaf maker at ${c.makers.join(', ')}, the covenant orders the testnet's book holds.`,
      `- ${K} wallets, one trade at a time each, amounts between ${c.amount[0]} and ${c.amount[1]} atoms, the direction alternating, each paid ${c.fund_each} of each asset by the maker in the tree.`,
      '- The parent chain was not forced into a contest on the testnet; the anchor reorganisations the trades met are counted below.',
    ],
  }
}

async function main () {
  const S = STACK ? await testnetStack(STACK) : await regtestStack()
  const { X, Y } = S
  note(`drill: ${N} trades, ${K} wallets, ${S.kind}; chain ${S.genesis}; ${S.names[X]} ${X}, ${S.names[Y]} ${Y}`)
  // The pairs the drill runs; it admits them only when every trade passes.
  const xy = ['leaf-maker', 'covenant-round', ...(S.prepare ? ['leaf-resting'] : [])]
  const pairsDrill = { chains: { [S.genesis]: { pairs: [{ pay: X, receive: Y, sources: xy }, { pay: Y, receive: X, sources: xy },
    ...(S.btcRpcs ? [{ pay: X, receive: 'BTC', sources: ['btc-gateway'] }, { pay: 'BTC', receive: X, sources: ['btc-gateway'] }] : [])] } } }
  writeFileSync(join(out, 'pairs-run.json'), JSON.stringify(pairsDrill, null, 2))
  const wallets = []
  for (let i = 0; i < K; i++) {
    // Each wallet's configuration, with its own Bitcoin Lightning node when BTC is traded.
    const cfgFile = join(out, `wallet-config-${i}.json`)
    writeFileSync(cfgFile, JSON.stringify({ ...S.walletConfig, pairs_file: join(out, 'pairs-run.json'), ...(S.btcRpcs ? { btc_rpc: S.btcRpcs[i] } : {}) }), { mode: 0o600 })
    const w = walletProc(i, cfgFile); await w.start(); wallets.push(w); children.push({ kill: () => w.kill() })
  }
  await S.fund(wallets)
  if (S.prepare) await S.prepare()

  let done = 0
  let notOfferedInRow = 0
  let aborted = null
  const MAX_NOT_OFFERED = 100
  const results = []
  const counts = { settled: 0, returned: 0, failed: 0, notOffered: 0, closes: 0, restarts: 0, contests: 0, reorgsMet: 0 }
  let nextId = 0
  const disruptionsBusy = { restart: false }
  const topUp = S.topUp

  // The wallet's live balance once no coin of it is moving (a round, a reorganisation).
  async function quietBalance (w) {
    const end = Date.now() + 180000
    for (;;) {
      await w.call('/run', { command: 'sync' }).catch(() => {})
      const b = await w.call('/balance')
      if (!b.moving || Date.now() > end) return b.live
      await sleep(1500)
    }
  }

  async function oneTrade (w) {
    const id = ++nextId
    const dirs = S.btcRpcs ? [[Y, X], [X, Y], [X, 'BTC'], ['BTC', X]] : [[Y, X], [X, Y]]
    const [pay, receive] = dirs[id % dirs.length]
    const amount = S.amount(pay)
    const before = await quietBalance(w)
    const t0 = Date.now()
    const r = await w.call('/trade', { pay, receive, amount })
    const res = { trade: id, wallet: w.i, pay: S.names[pay], amount, at: new Date().toISOString() }
    if (!r.ok) {
      if (r.why === 'confirm') { res.outcome = 'returned'; res.note = 'confirm refused before anything was signed: ' + r.error }
      else { res.outcome = 'not-offered'; res.note = r.why }
    } else {
      res.source = r.ticket.source; res.ticket = r.ticket; res.record = r.record.id
      res.sentMs = Date.now() - t0
      const disruption = []
      // Disruptions, once Sent.
      if (id % CLOSE_EVERY === 0) {
        await w.kill(); counts.closes++; disruption.push('wallet closed')
        const gap = rand(5, 40) * 1000; await sleep(gap); await w.start()
        disruption.push(`started again after ${gap / 1000} s`)
      }
      if (id % RESTART_EVERY === 0 && !disruptionsBusy.restart) {
        disruptionsBusy.restart = true
        try { await S.restart(); counts.restarts++; disruption.push('operator restarted') } catch (e) { disruption.push('operator not restarted: ' + e.message) } finally { disruptionsBusy.restart = false }
      }
      let contested = !(S.contest && id % CONTEST_EVERY === 0)
      let rec = null
      const end = Date.now() + WAIT_MS
      while (Date.now() < end) {
        const l = await w.call('/advance').catch(() => [])
        const recs = await w.call('/records').catch(() => [])
        rec = recs.find((x) => x.id === r.record.id) || rec
        if (rec && ['settled', 'returned', 'failed'].includes(rec.state)) break
        if (!contested && rec) {
          // The round of the trade (the take's, or the settling one), once it is in a block.
          const pids = rec.take ? [rec.take] : (rec.settle && rec.settle.participations) || []
          if (!pids.length && rec.source === 'btc-gateway' && rec.dir === 'sell') contested = true // no round of the wallet's own
          const parts = pids.length ? await w.call('/run', { command: 'participations' }).catch(() => []) : []
          const round = (parts.find((p) => pids.includes(p.participation) && p.round) || {}).round
          if (round) {
            const said = await S.contest(round)
            if (said) { counts.contests++; contested = true; disruption.push(said) }
          }
        }
        await sleep(1500)
      }
      if (disruption.length) res.disruption = disruption
      res.state = rec ? rec.state : 'unknown'
      res.settledMs = Date.now() - t0
      const after = await quietBalance(w)
      const d = (a) => big(after[a]) - big(before[a])
      res.moved = { pay: String(d(pay)), receive: String(d(receive)) }
      if (res.state === 'settled') {
        const ok = d(pay) === -big(r.ticket.amountIn) && d(receive) === big(r.ticket.amountOut)
        res.outcome = ok ? 'settled' : 'failed'
        if (!ok) res.note = `the ticket said ${r.ticket.amountIn} in and ${r.ticket.amountOut} out; ${-d(pay)} left and ${d(receive)} came`
      } else if (res.state === 'returned') {
        // Nothing traded: what left is at most the fees the return names (a take's payment to
        // itself, spent before the take was voided), and nothing came.
        const kept = (rec.feesPaid || []).filter((f) => f.asset === pay).reduce((n, f) => n + big(f.atoms), 0n)
        const ok = d(pay) === -kept && d(receive) === 0n
        if (kept > 0n) res.feesPaid = String(kept)
        res.outcome = ok ? 'returned' : 'failed'
        if (!ok) res.note = `returned, but ${-d(pay)} of the pay asset left (its fees paid ${kept}) and ${d(receive)} of the receive asset came`
      } else if (res.state === 'failed' && d(pay) === 0n && d(receive) === 0n) {
        // A step that did not answer and never showed: nothing traded, nothing moved.
        res.outcome = 'returned'; res.note = 'the step did not answer and never went through: ' + (rec && rec.error)
      } else { res.outcome = 'failed'; res.note = `neither settled nor returned within ${WAIT_MS / 1000} s (state ${res.state})` }
    }
    counts[res.outcome === 'not-offered' ? 'notOffered' : res.outcome]++
    if (res.outcome !== 'not-offered') { done++; notOfferedInRow = 0 } else {
      // Nothing to fill now (a maker that ran short, an order book drained): wait before asking
      // again, and end the run once nothing has been offered for a long while.
      notOfferedInRow++
      if (notOfferedInRow >= MAX_NOT_OFFERED && !aborted) { aborted = `nothing offered for ${MAX_NOT_OFFERED} quotes in a row: the stack has nothing left to trade against`; note('stopping: ' + aborted) }
      else await sleep(10000)
    }
    results.push(res)
    appendFileSync(tradesFile, JSON.stringify(res) + '\n')
    note(`trade ${id} wallet ${w.i} ${res.pay}→ ${amount}: ${res.outcome}${res.source ? ' via ' + res.source : ''}${res.settledMs ? ` in ${(res.settledMs / 1000).toFixed(0)} s` : ''}${res.disruption ? ' [' + res.disruption.join('; ') + ']' : ''}${res.note ? ' — ' + res.note : ''}`)
    if (id % 25 === 0) await topUp()
  }

  // Each wallet trades one trade at a time until N trades ran (not-offered quotes are not trades).
  await Promise.all(wallets.map(async (w) => {
    while (done < N && !aborted) {
      try { await oneTrade(w) } catch (e) { note(`wallet ${w.i}: ${e.message}`); try { if (w.proc.exitCode != null) await w.start() } catch {} await sleep(2000) }
    }
  }))
  await S.stop()

  // ---- the report ----
  const traded = results.filter((r) => r.outcome !== 'not-offered')
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
  const by = (src) => traded.filter((r) => r.source === src)
  const passed = counts.failed === 0 && traded.length >= N && !aborted
  const commit = (() => { try { return execFileSync('git', ['-C', resolve(here, '..'), 'rev-parse', '--short', 'HEAD']).toString().trim() } catch { return '?' } })()
  const lines = []
  lines.push('# User-mode drill report', '')
  lines.push(`The user-mode composer's trades on one stack, each settled or cleanly returned with no user action, the ticket checked against what moved. This report is written by \`tooling/user-mode-drill.mjs\`; \`pairs.json\` beside it lists what user mode offers on each chain.`, '')
  lines.push('## Result', '')
  lines.push(`- Trades: ${traded.length}; settled ${counts.settled}, returned ${counts.returned} (of them ${traded.filter((r) => r.outcome === 'returned' && r.feesPaid).length} with the fees of a payment to itself spent, which come back at that coin's next refresh), failed ${counts.failed}. Quotes that found nothing to fill (not trades): ${counts.notOffered}.`)
  if (aborted) lines.push(`- Stopped early: ${aborted}.`)
  lines.push(`- Verdict: ${passed ? 'passed: every trade settled or was cleanly returned, every settled trade moved exactly what its ticket showed, and every returned one nothing but the fees it named' : 'not passed'}.`)
  lines.push(`- Disruptions: the wallet closed mid-trade ${counts.closes} times, the operator restarted ${counts.restarts} times, the parent chain reorganised under a trade's round ${counts.contests} times${S.contest ? '' : ' (not forced on this chain)'}.`)
  lines.push(`- By source: in-tree swaps with the live leaf maker ${by('leaf-maker').length}, covenant orders taken in a round ${by('covenant-round').length}, orders resting in the tree filled ${by('leaf-resting').length}${S.btcRpcs ? `, BTC in one hash-lock with the maker's desk ${by('btc-gateway').length} (selling for BTC ${by('btc-gateway').filter((r) => r.pay !== 'BTC').length}, buying with BTC ${by('btc-gateway').filter((r) => r.pay === 'BTC').length})` : ''}.`)
  const sent = traded.filter((r) => r.sentMs).map((r) => r.sentMs), sett = traded.filter((r) => r.outcome === 'settled').map((r) => r.settledMs)
  lines.push(`- Time to Sent: median ${((pct(sent, 0.5) || 0) / 1000).toFixed(1)} s, 95th percentile ${((pct(sent, 0.95) || 0) / 1000).toFixed(1)} s. Time to Settled: median ${((pct(sett, 0.5) || 0) / 1000).toFixed(1)} s, 95th percentile ${((pct(sett, 0.95) || 0) / 1000).toFixed(1)} s.`)
  lines.push('', '## The stack', '')
  lines.push(`- The web wallet at \`${commit}\`, its leaf library (\`leaves/pkg\`) in Node, each wallet a process of its own running \`user-trade.js\`, the code the page runs.`)
  for (const l of S.describe) lines.push(l)
  lines.push('', '## Failures', '')
  const fails = traded.filter((r) => r.outcome === 'failed')
  if (!fails.length) lines.push('None.')
  for (const f of fails) lines.push(`- Trade ${f.trade} (wallet ${f.wallet}, ${f.source || '?'}): ${f.note}${f.disruption ? ' [' + f.disruption.join('; ') + ']' : ''}`)
  lines.push('', '## Every trade', '', 'One line per trade in `trades.jsonl`: its source, ticket, what moved, its disruptions and its outcome.', '')
  writeFileSync(join(out, 'REPORT.md'), lines.join('\n') + '\n')
  if (passed) {
    const admitted = { chains: { [S.genesis]: { pairs: pairsDrill.chains[S.genesis].pairs.map((p) => ({ ...p, proven: S.kind, report: 'REPORT.md' })) } } }
    writeFileSync(join(out, 'pairs.json'), JSON.stringify(admitted, null, 2) + '\n')
  }
  note(`done: ${JSON.stringify(counts)}; ${passed ? 'passed' : 'NOT PASSED'}`)
  S.logs()
  return passed
}

// Stopped from outside, it stops what it started.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { note(`stopped by ${sig}`); for (const c of children) { try { await c.kill() } catch {} } process.exit(130) })

main().then((ok) => { process.exitCode = ok ? 0 : 1 }).catch((e) => { note('FAIL ' + (e.stack || e.message)); process.exitCode = 1 }).finally(async () => {
  for (const c of children) { try { await c.kill() } catch {} }
  setTimeout(() => process.exit(process.exitCode || 0), 1000)
})
