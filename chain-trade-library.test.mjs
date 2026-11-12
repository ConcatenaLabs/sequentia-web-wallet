// A trade paid with money received on the chain a moment ago, against the real leaf wallet library,
// a real operator and a live leaf maker (tooling/lsp/leaf-maker.mjs): the engine (user-trade.js)
// prices it at once, the ticket saying how long; once confirmed the wallet moves the money in
// (leaves.js bringIn), and the trade goes ahead by itself once that is final, accepted once
// however often it is followed at the same time, and at the ticket's price or better.
//
// It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs) at
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm build (../pkg, or LWK_PKG) for the maker's
// phrase; it skips itself otherwise:
//
//   (the harness started with ARCA_OPERATOR_MORE_ASSETS=1, so the maker gives an asset the node prices)
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 LWK_PKG=<SWK>/lwk_wasm/pkg node --test chain-trade-library.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import { boardMinutes } from './default-arca.js'
import { createEngine, USER_WORDS, tradeStateWord, costLine } from './user-trade.js'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('./leaves/pkg', import.meta.url).pathname
const LWK = process.env.LWK_PKG || new URL('./pkg', import.meta.url).pathname
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package in leaves/pkg'
    : !existsSync(join(LWK, 'lwk_wasm.js')) ? 'needs the wallet kit\'s lwk_wasm build (LWK_PKG)' : false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function libraryWorker (lib, opened) {
  let wallet = opened
  const w = { asked: [] }
  w.postMessage = ({ id, op, args = {} }) => setImmediate(() => {
    let reply
    try {
      const value = op === 'exists' ? lib.exists(args.mnemonic)
        : op === 'open' ? (wallet = wallet || lib.open(args.mnemonic, args.nodePassword), true)
          : op === 'run' ? (() => {
            try { const v = wallet.run(String(args.command), args.args || {}); w.asked.push(String(args.command)); return v } catch (e) { w.asked.push(args.command + ':' + (e.kind || 'error')); throw e }
          })()
            : (() => { throw new Error('no operation ' + op) })()
      reply = { id, ok: true, value }
    } catch (e) { reply = { id, ok: false, error: { ...e, kind: e.kind || 'error', message: e.message } } }
    w.onmessage({ data: reply })
  })
  return w
}

test('a trade of money received on the chain: priced at once, moved in, then traded once at the ticket\'s price', { skip, timeout: 2_400_000 }, async (t) => {
  process.env.LWK_PKG = LWK
  const { harness, startMaker, makerReady, freePort, lwkFrom } = await import('./tooling/user-mode-stack.mjs')
  const H = harness(CONTROL)
  let st = await H.state()
  // The maker's budget is a share of the operator's bond: posted first.
  if (!st.bond) { await H.c('/bond_post', { amount: 50000000 }); st = await H.state() }
  // The maker quotes only what the node prices for fees: the harness's extra listed asset.
  assert.ok(st.more && st.more.length, 'the harness serves one more asset listed for fees (ARCA_OPERATOR_MORE_ASSETS=1)')
  const X = st.x, Y = st.more[0]
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  const dir = mkdtempSync(join(tmpdir(), 'chain-trade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A live maker selling Y for X at 5 X per 4 Y.
  const lwk = await lwkFrom(LWK)
  const maker = await startMaker(H, st, join(dir, 'maker'), { pairs: [{ give: Y, want: X, rate_num: '5', rate_den: '4', min_give: '10000' }],
    fund: [[Y, 6000000], [X, 1000000]], port: await freePort(), lwk, settleSeconds: 20, syncSeconds: 3, coinSize: 2000000, exitDelayUnits: 254 })   // as the page's wallet's coins, within what it accepts (254 to 338 units)
  t.after(() => maker.stop())
  await makerReady(H, maker, Y, 400000)
  await H.c('/fund_server', { asset: X, amount: 200000000 }); await H.c('/fund_server', { asset: Y, amount: 200000000 }); await H.produce()

  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./tooling/leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))
  const phrase = lwk.Mnemonic.fromRandom(12).toString()
  const A = lib.create(phrase, cfg)
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const worker = libraryWorker(lib, A)
  const api = mountLeaves({ makeWorker: () => worker, store, walletTag: () => 't', mnemonic: () => phrase, el: () => ({}), tickMs: 3_600_000 }, null, null)
  t.after(() => api.stop())
  await api.start()
  // Paid 3,000,000 X at its address on the chain: the page sees it at once.
  const chain = { [X]: 3000000n }
  await H.fund(A.command('address').script_pubkey, X, 3000000)
  const onChain = (a) => { const n = api.onchainLessBoards(a, chain[a] || 0n); return n > 0n ? n : 0n }
  const eng = createEngine({
    leaves: { command: (cmd, args) => api.pay(cmd, args), hold: api.hold },
    fetchJson: async (url, init) => { const r = await fetch(url, init ? { ...init, headers: { 'content-type': 'application/json' } } : undefined); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j },
    makers: () => [maker.url],
    admitted: () => ({ pairs: { chains: { [st.genesis_hash]: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: st.genesis_hash }),
    held: (a) => onChain(a) + (api.leafAtoms(a) || 0n) + (api.onItsWay(a) || 0n),
    chain: (a) => ({ atoms: onChain(a), movable: onChain(a), margin: 4000n, minutes: boardMinutes(api.anchorDepth()) }),
    bringIn: (a, want, o = {}) => api.bringIn(a, { want, until: o.until, since: o.since, stop: o.stop }),
    movedFees: (a, since) => api.movedFees(a, since),
    store: memStore(), tag: () => 't', log: (...a) => console.log(...a),
  })

  // Within the wallet's instant budget under the harness's bond (500,000 of the reference unit).
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  console.log('quote of 400,000 X held on the chain:', q.ok ? JSON.stringify(q.ticket) : q.why)
  assert.ok(q.ok, 'priced at once, not ' + q.why)
  assert.equal(q.ticket.bringIn, boardMinutes(api.anchorDepth()))
  // All-in (RV43 B1): the fee line is the most the fees can be, never "No fees".
  const feeLine = costLine(q.ticket.fees, (a, n) => `${n} ${a === X ? 'X' : 'Y'}`, X)
  console.log('the ticket\'s fee line:', feeLine)
  assert.notEqual(feeLine, USER_WORDS.noFees)
  assert.equal(feeLine, 'Fees at most 4000 X, included above')
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'settling')
  assert.equal(tradeStateWord(rec), USER_WORDS.bringIn(q.ticket.bringIn))
  // The operator's clock runs; the page follows its trades, twice at once each time.
  const t0 = Date.now()
  let r = rec
  for (let i = 0; i < 200 && !['sent', 'settled', 'returned', 'failed'].includes(r.state); i++) {
    try { await H.c('/build'); await H.c('/pass'); await H.produce(); await H.bury() } catch {}
    await Promise.all([eng.resume(), eng.resume()])
    r = eng.records().find((x) => x.id === rec.id)
    if (i % 5 === 0) console.log(`after ${Math.round((Date.now() - t0) / 1000)} s: ${r.state}`)
    await sleep(2000)
  }
  console.log(`the trade: ${r.state} after ${Math.round((Date.now() - t0) / 1000)} s; ticket pay ${q.ticket.amountIn} receive ${q.ticket.amountOut}; went ahead pay ${r.ticket.amountIn} receive ${r.ticket.amountOut}`)
  const asked = worker.asked.filter((c) => /^(board|swap_accept)(:|$)/.test(c))
  console.log('the library was asked ' + asked.join(', '))
  assert.ok(['sent', 'settled'].includes(r.state), r.state + ' ' + (r.error || ''))
  assert.equal(asked.filter((c) => c === 'swap_accept').length, 1, 'accepted once: ' + asked.join(','))
  assert.equal(asked[0], 'board', 'moved in first')
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut), 'no less received than the ticket')
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn), 'no more paid than the ticket, the move\'s fee counted')
  const mf = api.movedFees(X, 0)
  console.log(`the record: pay ${r.ticket.amountIn} (the move's fee ${mf} counted), fees ${JSON.stringify(r.ticket.fees.map((f) => f.atoms))}`)
  assert.ok(mf > 0n && r.ticket.fees.some((f) => f.atoms === String(mf)), 'the move\'s fee is in the record\'s fees')
  // Once it has gone ahead, nothing keeps moving money in (RV43 B2): no reads of the chain for it.
  const sentAt = Date.now(), mark = worker.asked.length
  // The Y arrives in the wallet.
  for (let i = 0; i < 60; i++) {
    try { await api.syncNow() } catch {}
    const got = (A.command('coins') || []).filter((c) => c.asset === Y && !/^(spent|given_up)$/.test(c.state)).reduce((n, c) => n + BigInt(c.value), 0n)
    if (i % 10 === 0) console.log('waiting for the Y: record', eng.records().find((x) => x.id === rec.id).state, 'swaps', JSON.stringify((A.command('swaps') || []).map((x) => x.state)), 'Y coins', String(got))
    if (got >= BigInt(r.ticket.amountOut)) {
      console.log('the wallet holds', String(got), 'Y')
      const after = worker.asked.slice(mark)
      console.log(`after the trade went ahead (${Math.round((Date.now() - sentAt) / 1000)} s): moving in ${api.bringing()}, balance reads ${after.filter((c) => c === 'balance').length}, boards ${after.filter((c) => c === 'board').length}`)
      assert.equal(api.bringing(), false, 'no move in runs once the trade has gone ahead')
      // What the wallet's X fell by, against the ticket (RV43 P1; the part beyond the record is #706's).
      const coins = A.command('coins') || []
      const xHeld = coins.filter((c) => c.asset === X && !/^(spent|given_up|forfeited)$/.test(c.state)).reduce((n, c) => n + BigInt(c.value), 0n)
      const onc = BigInt(((A.command('balance').sequentia_onchain) || {})[X] || 0)
      const fell = 3000000n - xHeld - onc
      console.log(`the wallet's X fell by ${fell}: the ticket said ${q.ticket.amountIn}, the record ${r.ticket.amountIn}; beyond the record ${fell - BigInt(r.ticket.amountIn)} (margins of the trade's coins, #706)`)
      return
    }
    try { await H.c('/build'); await H.c('/pass'); await H.produce(); await H.bury() } catch {}
    await eng.resume(); await sleep(2000)
  }
  console.log('the maker said:\n' + maker.log.slice(-25).join('').slice(-5000))
  assert.fail('the Y never came')
})
