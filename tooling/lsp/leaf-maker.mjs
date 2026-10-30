#!/usr/bin/env node
// A live leaf maker: it holds leaves of one operator's tree, quotes in-tree swaps for the pairs
// its configuration names, and settles each in one reassignment with the wallet that takes it.
// It is the in-tree source of the user-mode composer's single-step book
// (tooling/lsp/single-step-book.mjs 'leaf-maker'; user-trade.js settles against it).
//
// It quotes only what it holds: a quote's `max_give` is what its leaf library can pay now
// (its live coins, less the coin of any open offline-refresh plan; a firm offer's coins are held
// for it and are not live), less a margin for the swap's own fees. Nothing it cannot fill is
// quoted.
//
// HTTP (JSON; CORS open, since a page may reach it from another origin):
//   GET  /health              -> { ok, operator, genesis_hash }
//   GET  /v1/quotes           -> { operator, genesis_hash, as_of, quotes: [{ give_asset, want_asset, rate_num, rate_den,
//                                  min_give, max_give }] }   (the maker gives give_asset and wants
//                                  ceil(give × rate_num / rate_den) of want_asset; with a ladder, one
//                                  quote a level, each carrying the depth of the levels before it), from
//                                  the holdings read at `as_of` (unix seconds): every pass and every offer
//                                  renews them, and a quote never waits on the library
//   POST /v1/firm {give_asset, want_asset, give}  -> { swap, offer, give, want, expires_at }: an in-tree swap
//                                  offer of the leaf library's (`swap_offer`), its coins held until it is
//                                  completed, released or lapses (`offer_ttl_seconds`), priced by walking
//                                  the ladder's levels: never above ceil(give × the rate of any quote
//                                  whose max_give carries `give`)
//   POST /v1/accept {swap, accept} -> { swap, state: 'done' }: completes the swap (`swap_complete`, the
//                                  operator co-signing); asked again it answers the same
//   POST /v1/release {swap}       -> { swap, state }: cancels a firm offer nobody took
//   GET  /v1/swap/<id>            -> { swap, state }
//
// Run:  node tooling/lsp/leaf-maker.mjs --config maker.json
//       node tooling/lsp/leaf-maker.mjs --config maker.json --init   (draws the maker's phrase, once;
//            LWK_PKG names the wallet kit's lwk_wasm build when ../../pkg is not there)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --ask-faucet URL ASSET TICKER
//            (a receive request paid by the testnet faucet as a leaf; prints what came, exits)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --address    (its on-chain address)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --held ASSET (atoms it holds in leaves)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --pay FILE   (pays the receive
//            requests in FILE from its leaves, in the tree; for a drill's wallets)
// The one-shot modes open the maker's store: stop its service first.
//
// The configuration (JSON) names the maker's own wallet and nothing else's:
//   { "wallet": "leaf-maker-1",                 a name of the maker's own; a service or treasury
//                                                wallet's name (treasury, reserve, faucet, bridge,
//                                                sbtc, pool, fee, service) is refused
//     "mnemonic_file": "/path/mnemonic",        mode 0600, the maker's own phrase (--init writes it)
//     "store_dir": "/path/store",               the leaf library's store
//     "operator": { "server": "https://…/arca", "node_url": "https://…/node", "node_user": "…",
//                   "node_password_file": "/path/…" },
//     "listen": "127.0.0.1:9979",
//     "pairs": [ { "give": "<asset hex>", "want": "<asset hex>", "rate_num": "1", "rate_den": "1",
//                  "min_give": "10000" } ],      or "price": true in place of the rate, priced from
//     "prices": { "url": "https://…/prices",    the price server's feed with the spread on the
//                 "spread_bps": 100,             maker's side, read every minute; a pair whose
//                 "assets": { "<hex>": { "ticker": "USDX", "precision": 8 } } },   price is missing
//                                                or older than ten minutes is not quoted
//     "ladder": { "levels": 8, "step_bps": 25, "growth": 1.25, "first": "5000000" },   optional, and a
//                                                pair may carry its own: what it holds of an asset it
//                                                gives is quoted at `levels` price levels, each
//                                                `step_bps` further from its rate and `growth` times
//                                                larger than the one before, level 1 `first` atoms
//                                                (else the holding split over the levels), one quote
//                                                a level, cumulative (quote k: level k's rate, the
//                                                depth of levels 1..k); a firm offer walks the levels
//                                                (leaf-maker-ladder.mjs). Without it, one level of
//                                                all it holds
//     "fee_margin": "2000",                      atoms of each asset kept back for a swap's fees
//     "offer_ttl_seconds": 300, "sync_seconds": 20, "settle_seconds": 600,
//     "board_keep": "100000",                    on-chain atoms of each asset it gives that it keeps
//                                                (for exit fees); what it holds above that is boarded.
//                                                This, coin_size and fee_margin each take one figure
//                                                for every asset, or { "<asset hex>": "atoms", …,
//                                                "default": "atoms" }
//     "coin_size": "2000000",                    optional: boards in coins of at most this many atoms,
//                                                one a pass, so several takers are served at once
//     "exit_delay_units": 36,                    optional; the operator's default otherwise
//     "rest": { … },                             optional: orders resting in the tree, a ladder a
//                                                pair, listed on SeqDEX's relay (leaf-maker-rest.mjs
//                                                says how)
//     "report": { "relay": "http://…" },        optional: where its trades are reported (else the
//                                                resting desk's relay); trade-report.mjs says how
//     "btc": { … } }                             optional: BTC for an asset and an asset for BTC in
//                                                one hash-lock, from the maker's own Bitcoin
//                                                Lightning node (leaf-maker-btc.mjs says how)
// Every coin the maker receives is refreshed in the operator's next round once it has rested
// `settle_seconds`, so what it trades settles as the takers' coins do.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leafLibraryThread } from '../leaf-node.mjs'
import { spendableFrom } from '../../user-trade.js'
import { btcDesk } from './leaf-maker-btc.mjs'
import { restDesk } from './leaf-maker-rest.mjs'
import { tradeReporter, makerRelayKey } from './trade-report.mjs'
import { perAsset, ladderOf, slicesOf, ladderQuotes, walkWant } from './leaf-maker-ladder.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const log = (...a) => console.log(new Date().toISOString(), ...a)

export const REFUSED_WALLETS = /(treasury|reserve|faucet|bridge|sbtc|pool|fee|service|founder|drip)/i

// A pair's rate from the price server's feed (`/prices`: { TICKER: price or {price} }, each in
// the same reference unit per whole unit of the asset), with the maker's spread: the maker wants
// `rate_num` atoms of what it wants for every `rate_den` atoms it gives. Null when either price is
// missing, so nothing is quoted on a price the maker does not have.
export function rateFromPrices (prices, give, want, spreadBps) {
  // The feed's own key first (it names bitcoin `tBTC` on the testnet), then the ticker in capitals.
  const p = (t) => { const v = prices && (prices[String(t.ticker)] ?? prices[String(t.ticker).toUpperCase()]); const n = Number(v && typeof v === 'object' ? v.price : v); return n > 0 ? n : null }
  const pg = p(give), pw = p(want)
  if (!pg || !pw) return null
  const DEN = 100000000n
  // atoms of `want` per atom of `give`, the spread on the maker's side.
  const ratio = (pg / pw) * 10 ** ((want.precision ?? 8) - (give.precision ?? 8)) * (1 + Number(spreadBps || 0) / 10000)
  const num = BigInt(Math.ceil(ratio * Number(DEN)))
  if (num <= 0n) return null
  return { rate_num: String(num), rate_den: String(DEN) }
}

// Whether a pair's freshly read rate replaces the one quoted now: a rate more than twice, or less
// than half, of the current one is a reading the maker does not trust at once (a feed that
// glitched would have it give its coins away), and is taken only once `JUMP_READS` readings in a
// row say so; meanwhile the current rate stays. `jumps` counts those readings per pair.
// -> the rate to quote.
export const JUMP_READS = 3
export function steadyRate (key, prev, next, jumps) {
  if (!prev || !next) { jumps.delete(key); return next }
  const ratio = (Number(next.rate_num) / Number(next.rate_den)) / (Number(prev.rate_num) / Number(prev.rate_den))
  if (ratio <= 2 && ratio >= 0.5) { jumps.delete(key); return next }
  const n = (jumps.get(key) || 0) + 1
  if (n < JUMP_READS) { jumps.set(key, n); return prev }
  jumps.delete(key)
  return next
}

export function checkConfig (c) {
  if (!c || typeof c !== 'object') throw new Error('the configuration is not an object')
  if (!c.wallet || REFUSED_WALLETS.test(String(c.wallet))) throw new Error(`refused: the maker runs only a wallet of its own, never a service or treasury wallet (${JSON.stringify(c.wallet)})`)
  for (const k of ['mnemonic_file', 'store_dir', 'listen']) if (!c[k]) throw new Error(`the configuration names no ${k}`)
  if (REFUSED_WALLETS.test(String(c.mnemonic_file)) || REFUSED_WALLETS.test(String(c.store_dir))) throw new Error('refused: the phrase or store is a service or treasury wallet\'s')
  if (!c.operator || !c.operator.server || !c.operator.node_url) throw new Error('the configuration names no operator')
  for (const p of c.pairs || []) {
    if (!/^[0-9a-f]{64}$/.test(p.give) || !/^[0-9a-f]{64}$/.test(p.want) || p.give === p.want) throw new Error('a pair names two asset ids')
    if (!p.price && !(big(p.rate_num) > 0n && big(p.rate_den) > 0n)) throw new Error('a pair\'s rate is two positive integers, or "price": true with the configuration\'s price feed')
    if (p.price && !(c.prices && c.prices.url && c.prices.assets && c.prices.assets[p.give] && c.prices.assets[p.want])) throw new Error('a pair priced from the feed needs prices.url and both assets in prices.assets')
  }
  return c
}

// The quotes, from what the library can pay now and what open offers hold: a pair's depth at the
// levels of its ladder (leaf-maker-ladder.mjs), one quote a level, cumulative.
export function quotesFrom (pairs, spendable, held, margin, rates = new Map(), cfg = null) {
  const out = []
  for (const p0 of pairs || []) {
    const sl = slicesFor(p0, spendable, held, margin, rates, cfg)
    if (sl) out.push(...ladderQuotes(p0.give, p0.want, sl.slices, sl.min))
  }
  return out
}

// A pair's ladder now: its rate (fixed, or from the feed), what the maker can give of it, and the
// slices of that. Null when the pair is not quoted (no live price, or not enough to give).
export function slicesFor (p0, spendable, held, margin, rates = new Map(), cfg = null) {
  const r = p0.price ? rates.get(p0.give + ':' + p0.want) : null
  if (p0.price && !r) return null
  const p = r ? { ...p0, ...r } : p0
  const have = (spendable.get(p.give) || 0n) - (held.get(p.give) || 0n) - big(perAsset(margin, p.give, 0))
  const min = big(p.min_give || 1)
  const slices = slicesOf(p, have, min, ladderOf(p0, cfg))
  return slices.length ? { slices, min, pair: p } : null
}

async function main () {
  const cfgPath = arg('--config')
  if (!cfgPath) { console.error('usage: leaf-maker.mjs --config maker.json [--init]'); process.exit(2) }
  const cfg = checkConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  if (process.argv.includes('--init')) {
    if (existsSync(cfg.mnemonic_file)) { console.log(`the maker's phrase is already at ${cfg.mnemonic_file}`); return }
    const pkg = process.env.LWK_PKG || join(here, '..', '..', 'pkg')
    const lwk = await import(join(pkg, 'lwk_wasm.js'))
    lwk.initSync({ module: readFileSync(join(pkg, 'lwk_wasm_bg.wasm')) })
    writeFileSync(cfg.mnemonic_file, lwk.Mnemonic.fromRandom(12).toString() + '\n', { mode: 0o600 })
    chmodSync(cfg.mnemonic_file, 0o600)
    console.log(`wrote the maker's phrase to ${cfg.mnemonic_file}`)
    return
  }
  // --reporter-key: the key the maker signs its trade reports and listings with, for the relay's
  // -trade-reporters; exits.
  if (process.argv.includes('--reporter-key')) { console.log(makerRelayKey(cfg.store_dir).pub); return }
  const mnemonic = readFileSync(cfg.mnemonic_file, 'utf8').trim()
  const op = cfg.operator
  const nodePassword = op.node_password_file ? readFileSync(op.node_password_file, 'utf8').trim() : (op.node_password || '')
  // The library on a thread of its own: the maker answers HTTP while a long command runs, and a
  // taker's acceptance or a firm offer goes ahead of the maker's own upkeep.
  // A command slower than five seconds is logged by name: the upkeep's long ones are what a
  // firm offer waits behind.
  const lib = await leafLibraryThread(cfg.store_dir, { onSlow: (name, ms, detail) => log('slow', name, ms, 'ms', detail ? JSON.stringify(detail) : '') })
  const w = (await lib.exists(mnemonic)) ? await lib.open(mnemonic, nodePassword) : await lib.create(mnemonic, {
    server: op.server, node_url: op.node_url, node_user: op.node_user, node_password: nodePassword,
    ...(cfg.exit_delay_units ? { exit_delay_units: cfg.exit_delay_units } : {}),
    ...(cfg.min_exit_delay_units ? { min_exit_delay_units: cfg.min_exit_delay_units } : {}),
  })
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const cmd = (name, args, first = false) => w.command(name, args || {}, { first })
  const info = await cmd('info')
  // --address: the maker's on-chain address (to fund what it boards), then exits.
  if (process.argv.includes('--address')) { console.log(JSON.stringify({ address: (await cmd('address')).address })); process.exit(0) }
  // --held ASSET: what the maker holds of an asset in leaves (every state), after a sync; exits.
  const hi = process.argv.indexOf('--held')
  if (hi > 0) {
    try { await cmd('sync') } catch (e) { log('sync:', e.message) }
    const st = ((await cmd('balance')).arca || {})[process.argv[hi + 1]] || {}
    console.log(String(Object.values(st).reduce((n, v) => n + big(v), 0n)))
    process.exit(0)
  }
  // --pay FILE: pays each receive request in FILE (one a line) from the maker's leaves, out of
  // round, in the tree, then exits: how a drill's wallets are funded from the maker.
  const pi = process.argv.indexOf('--pay')
  if (pi > 0) {
    await cmd('sync')
    const out = []
    for (const req of readFileSync(process.argv[pi + 1], 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) {
      try { const r = await cmd('send', { request: req }); out.push({ ok: true, sent: r.sent || r.value || null }) } catch (e) { out.push({ ok: false, error: e.message }) }
    }
    console.log(JSON.stringify(out))
    process.exit(out.every((x) => x.ok) ? 0 : 3)
  }
  // --ask-faucet URL ASSET TICKER: a receive request in that asset, paid by the testnet faucet as
  // a leaf; prints what the faucet paid, and exits. The faucet pays its own tier, so a caller that
  // needs more asks again or names the shortfall.
  const ai = process.argv.indexOf('--ask-faucet')
  if (ai > 0) {
    const [url, asset, ticker] = process.argv.slice(ai + 1, ai + 4)
    const req = await cmd('receive', { asset })
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: req.request, asset: ticker }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { console.log(JSON.stringify({ ok: false, status: r.status, error: j.error || null })); process.exit(3) }
    await pause(3000)
    const mb = (await cmd('sync')).mailbox || {}
    const got = (mb.accepted || []).filter((x) => x.asset === asset).reduce((n, x) => n + big(x.value), 0n)
    console.log(JSON.stringify({ ok: true, paid: j.leaf && j.leaf.atoms ? String(j.leaf.atoms) : null, received: String(got) }))
    process.exit(0)
  }
  const address = await cmd('address')
  log(`leaf maker ${cfg.wallet}: operator ${info.operator}, chain ${info.genesis_hash}, on-chain address ${address.address}`)

  // Rates from the price feed, read every minute; a rate older than ten minutes is not quoted.
  const rates = new Map()
  const jumps = new Map()
  let ratesAt = 0
  const liveRates = () => (Date.now() - ratesAt < 10 * 60 * 1000 ? rates : new Map())
  async function readPrices () {
    if (!cfg.prices || !cfg.prices.url) return
    try {
      const r = await fetch(cfg.prices.url, { signal: AbortSignal.timeout(20000) })
      const j = await r.json()
      for (const p of [...(cfg.pairs || []), ...((cfg.btc && cfg.btc.pairs) || [])]) {
        if (!p.price) continue
        const key = p.give + ':' + p.want
        const read = rateFromPrices(j, cfg.prices.assets[p.give], cfg.prices.assets[p.want], cfg.prices.spread_bps)
        const rate = steadyRate(key, rates.get(key), read, jumps)
        if (read && rate !== read) log('prices: a reading of', key, 'far from the rate quoted now is held back', JSON.stringify(read))
        if (rate) rates.set(key, rate); else rates.delete(key)
      }
      ratesAt = Date.now()
    } catch (e) { log('prices:', e.message) }
  }
  await readPrices()
  setInterval(readPrices, 60000)
  // Every trade it settles is reported to the relay's trade log, when it names a relay.
  const reporter = tradeReporter({ cfg, log })
  if (reporter) log('trades are reported to', reporter.relay, 'signed by', reporter.pub)
  const reportTrade = (t) => { if (reporter) { try { reporter.report(t) } catch (e) { log('report:', e.message) } } }
  // BTC for an asset and back, from the maker's own Bitcoin Lightning node, when it has one.
  const desk = await btcDesk({ cfg, cmd, log, liveRates, onTrade: (s) => reportTrade({ rail: 'btc-gateway', id: s.swap, give_asset: s.give_asset, give: s.give, want_asset: s.want_asset, want: s.want }) })
  if (desk) log('the BTC desk is open')

  const firm = new Map()   // swap -> { give_asset, give, expires }
  const seen = new Map()   // leaf_id -> first seen (ms), for settling received coins
  let busy = false
  let lastBoardRefusal = null
  // What the maker can pay now. `first` asks the library ahead of its queue (a firm offer); the
  // quotes are served from the last reading (`holdings`), which every pass of the upkeep and every
  // offer and completion renew, so a quote never waits on the library: with a hundred coins and
  // resting orders a pass can hold the library for minutes, and a quote that waited on it was
  // no quote at all.
  const spendable = async (first = false) => {
    const sp = spendableFrom(await cmd('coins', {}, first), await cmd('plans', {}, first).catch(() => ({ plans: [] })))
    holdings = { sp, at: Date.now() }
    return sp
  }
  let holdings = null
  // Orders resting in the tree, a ladder a pair, listed on the relay (leaf-maker-rest.mjs).
  const rester = await restDesk({ cfg, cmd, log, liveRates, spendable })
  if (rester) log('the resting desk is open, its listings signed by', rester.makerPub)

  async function swapState (id, first = false) { return (((await cmd('swaps', {}, first)) || []).find((s) => s.swap === id) || {}).state || null }

  // The upkeep leaves the library free at least as long as its last pass held it, so a taker's
  // firm offer or acceptance is as likely to find it idle as busy.
  let passEnd = 0, passTook = 0, lastHold = 0
  const HOLDINGS_FOR_FIRM_MS = 5 * 60 * 1000
  // What a firm offer is sized on: the upkeep's last reading while it is fresh, else a reading
  // asked ahead of the queue.
  const firmHoldings = async () => (holdings && Date.now() - holdings.at < HOLDINGS_FOR_FIRM_MS ? holdings.sp : spendable(true))
  const HOLD_MS = 90_000, HOLD_EVERY_MS = 180_000
  async function tick () {
    if (busy || Date.now() - passEnd < passTook) return
    busy = true
    const t0 = Date.now()
    try { await tickOnce() } catch (e) { log('tick:', e.message) } finally { busy = false; passEnd = Date.now(); passTook = passEnd - t0 }
  }
  async function tickOnce () {
    {
      try { await cmd('sync') } catch (e) { log('sync:', e.message) }
      try { await spendable() } catch (e) { log('holdings:', e.message) }
      if (desk) { try { await desk.tick() } catch (e) { log('btc:', e.message) } }
      if (rester) { try { await rester.tick() } catch (e) { log('rest:', e.message) } }
      if (reporter && reporter.pending().length) { try { await reporter.flush() } catch (e) { log('report:', e.message) } }
      // What it holds on the chain of an asset it gives, above what it keeps, comes into the
      // tree: a board, its fee in the asset boarded when the node takes it for fees, else in
      // another asset the maker holds on the chain that the node takes (the wallet rule; never a
      // fallback to one privileged asset).
      try {
        const onchain = ((await cmd('balance')) || {}).sequentia_onchain || {}
        // The assets it gives: in-tree, and for BTC at its desk.
        const gives = [...(cfg.pairs || []), ...((cfg.btc && cfg.btc.pairs) || []).filter((x) => x.give !== 'BTC')]
        for (const a of new Set(gives.map((x) => x.give))) {
          let amount = big(onchain[a]) - big(perAsset(cfg.board_keep, a, '100000'))
          // In coins of `coin_size`, one a pass: a firm offer holds the coins it spends until it
          // is taken or released, so a maker of one coin serves one taker at a time.
          const coin = perAsset(cfg.coin_size, a, null)
          if (coin && amount > big(coin)) amount = big(coin)
          if (amount < big((gives.find((x) => x.give === a) || {}).min_give || 1)) continue
          const feeAssets = [a, ...Object.keys(onchain).filter((x) => x !== a && big(onchain[x]) > 0n).sort((x, y) => (big(onchain[y]) > big(onchain[x]) ? 1 : -1))]
          let done = false, why = null
          for (const fee of feeAssets) {
            try {
              const q = await cmd('board_quote', { asset: a, amount: String(amount), fee_asset: fee })
              await cmd('board', { asset: a, amount: String(amount), fee_asset: fee, shown: q.fee })
              log('boarded', String(amount), a.slice(0, 8), 'fee', JSON.stringify(q.fee))
              done = true; break
            } catch (e) { why = e.message; if (!/not accepted for fees/.test(e.message)) break }
          }
          if (!done && why !== lastBoardRefusal) { lastBoardRefusal = why; log('board:', why) }
        }
      } catch (e) { log('board:', e.message) }
      const t = Date.now()
      for (const [id, f] of firm) {
        const st = await swapState(id)
        if (st !== 'open') { firm.delete(id); continue }
        if (t > f.expires) { try { await cmd('swap_cancel', { swap: id }) } catch (e) { log('cancel', id, e.message) } firm.delete(id) }
      }
      // Coins it received, once rested, are refreshed in the operator's next round.
      const coins = (await cmd('coins')) || []
      const due = []
      for (const c of coins) {
        if (c.state !== 'live' || c.kind !== 'transfer') continue
        if (!seen.has(c.leaf_id)) seen.set(c.leaf_id, t)
        if (t - seen.get(c.leaf_id) > (cfg.settle_seconds ?? 600) * 1000) due.push(c.leaf_id)
      }
      if (due.length) {
        try {
          const q = await cmd('quote', { leaves: due })
          const r = await cmd('participate', { leaves: due, shown: q.coins })
          log('settling', due.length, 'received coins:', JSON.stringify((r.participations || []).map((p) => p.state || p.error)))
          for (const d of due) seen.delete(d)
        } catch (e) { log('settle:', e.message) }
      }
    }
  }

  const send = (res, code, v) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' })
    res.end(JSON.stringify(v))
  }
  const body = (req) => new Promise((ok) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(p).toString() || '{}')) } catch { ok(null) } }) })

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname.replace(/\/+$/, '')
    if (req.method === 'OPTIONS') return send(res, 200, {})
    try {
      if (req.method === 'GET' && (p === '/health' || p === '')) return send(res, 200, { ok: true, operator: info.operator, genesis_hash: info.genesis_hash })
      if (req.method === 'GET' && p === '/v1/quotes') {
        // A taker reading quotes asks for a firm offer next: the upkeep's next commands wait 90 s
        // so the offer finds the library free, at most once every three minutes so a reader that
        // polls cannot stop the upkeep.
        if (Date.now() - lastHold > HOLD_EVERY_MS) { lastHold = Date.now(); lib.hold(HOLD_MS) }
        const sp = holdings ? holdings.sp : await spendable(true)
        return send(res, 200, { operator: info.operator, genesis_hash: info.genesis_hash, as_of: Math.floor(holdings.at / 1000),
          quotes: [...quotesFrom(cfg.pairs, sp, new Map(), cfg.fee_margin || 0, liveRates(), cfg), ...(desk ? desk.quotes(sp, cfg.fee_margin || 0) : [])] })
      }
      if (req.method === 'GET' && p.startsWith('/v1/swap/')) { const id = p.slice('/v1/swap/'.length); return send(res, 200, { swap: id, state: await swapState(id, true) }) }
      if (desk && req.method === 'GET' && p.startsWith('/v1/btc/')) { const r = await desk.route('GET', p, {}); if (r) return send(res, r[0], r[1]) }
      if (req.method !== 'POST') return send(res, 404, { error: 'no such path' })
      const b = await body(req)
      if (!b) return send(res, 400, { error: 'the body is not JSON' })
      if (desk && p.startsWith('/v1/btc/')) {
        const r = await desk.route('POST', p, b, firmHoldings, cfg.fee_margin || 0)
        if (r) { if (p === '/v1/btc/paid') tick(); return send(res, r[0], r[1]) }
      }
      if (p === '/v1/firm') {
        const pair0 = (cfg.pairs || []).find((x) => x.give === b.give_asset && x.want === b.want_asset)
        if (!pair0) return send(res, 404, { error: 'the maker quotes no such pair' })
        const give = big(b.give)
        // Sized on the holdings the upkeep read last (each library command can take tens of seconds
        // on a wallet of a hundred coins): the library refuses an offer it cannot pay, and the
        // reading is renewed after the offer.
        const sl = slicesFor(pair0, await firmHoldings(), new Map(), cfg.fee_margin || 0, liveRates(), cfg)
        const w = sl && give >= sl.min ? walkWant(sl.slices, give) : null
        if (!w) return send(res, 409, { error: 'the maker does not hold that much now', quote: sl ? ladderQuotes(pair0.give, pair0.want, sl.slices, sl.min).pop() : null })
        const pair = sl.pair
        const want = w.want
        const o = await cmd('swap_offer', { give_asset: pair.give, give: String(give), want_asset: pair.want, want: String(want) }, true)
        const expires = Date.now() + (cfg.offer_ttl_seconds ?? 300) * 1000
        firm.set(o.swap, { give_asset: pair.give, give, want_asset: pair.want, want, expires })
        spendable().catch(() => {})   // renewed in the upkeep's turn, never ahead of a taker
        log('firm', o.swap.slice(0, 12), 'gives', String(give), pair.give.slice(0, 8), 'for', String(want), pair.want.slice(0, 8))
        return send(res, 200, { swap: o.swap, offer: o.offer, give: String(give), want: String(want), expires_at: Math.floor(expires / 1000) })
      }
      if (p === '/v1/accept') {
        const st = await swapState(b.swap, true)
        if (st === 'done') return send(res, 200, { swap: b.swap, state: 'done' })
        if (st !== 'open') return send(res, 409, { error: `the swap is ${st || 'unknown'} here`, state: st })
        const r = await cmd('swap_complete', { accept: String(b.accept || '') }, true)
        const f = firm.get(b.swap)
        if (f) reportTrade({ rail: 'leaf-maker', id: b.swap, give_asset: f.give_asset, give: f.give, want_asset: f.want_asset, want: f.want })
        firm.delete(b.swap)
        spendable().catch(() => {})   // renewed in the upkeep's turn, never ahead of a taker
        log('done', String(r.swap).slice(0, 12))
        return send(res, 200, { swap: b.swap, state: 'done' })
      }
      if (p === '/v1/release') {
        const st = await swapState(b.swap, true)
        if (st === 'open') { try { await cmd('swap_cancel', { swap: b.swap }) } catch (e) { log('release', e.message) } }
        firm.delete(b.swap)
        return send(res, 200, { swap: b.swap, state: await swapState(b.swap) })
      }
      return send(res, 404, { error: 'no such path' })
    } catch (e) {
      log('refused', p, e.message)
      return send(res, 409, { error: e.message, kind: e.kind || null })
    }
  })
  const [host, port] = String(cfg.listen).split(':')
  srv.listen(Number(port), host || '127.0.0.1', () => log(`leaf maker listening on ${host}:${srv.address().port}`))
  tick()
  setInterval(tick, (cfg.sync_seconds ?? 20) * 1000)
  const stop = () => { log('stopping'); srv.close(); lib.stop(); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message || e); process.exit(1) })
