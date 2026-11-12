// restricted-trade.js, restricted-engine.js and seqob.js's members 29 and 30: the taker's checks
// of a restricted asset's trade, the book's entries, the default screen's words and cards, and
// the trade against a stand-in maker that cheats. The trade against the real maker, policy
// server and node is the regtest drive (the pull request names it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const m = await import('./restricted-trade.js')
const { restrictedQuote, restrictedConfirm } = await import('./restricted-engine.js')
const seqob = await import('./seqob.js')
const { forbiddenIn } = await import('./user-trade.js')

const A = 'aa'.repeat(32) // the restricted asset
const B = 'bb'.repeat(31) + '01' // what pays for it
const F = 'cc'.repeat(31) + '02' // the fee asset
const ENC = '5120' + 'e1'.repeat(32) // our enclave
const MENC = '5120' + 'e2'.repeat(32) // the maker's enclave
const CH = '0014' + '0c'.repeat(20) // our change
const MREC = '0014' + 'a5'.repeat(20) // where the maker is paid
const coin = (n, asset, value, script) => ({ txid: String(n).padStart(2, '0').repeat(32), vout: 0, asset, value: BigInt(value), script })

// The honest trade in which we buy 300 A for 500 B, the fee in F.
function honest () {
  const seller = [coin(1, A, 300, MENC)]
  const pay = [coin(2, B, 700, CH)]
  const fee = [coin(3, F, 50, CH)]
  const lay = m.dvpLayout({ asset: A, value: 300n, assetB: B, price: 500n, sellerCoins: seller, sellerEnclave: MENC, sellerRecv: MREC,
    buyerCoins: pay, buyerEnclave: ENC, buyerChange: CH, feeCoins: fee, feeAsset: F, fee: 20n, feeChange: CH })
  const hex = m.buildTx(lay.inputs, lay.outputs)
  const side = { offered: [...pay, ...fee], walletOwns: new Set([...pay, ...fee].map((c) => `${c.txid}:0`)), ours: [ENC, CH],
    gives: { [B]: 500n, [F]: 20n }, gets: [{ asset: A, value: 300n, script: ENC }], feeFloor: () => 10n }
  return { lay, hex, side }
}

test('the unsigned trade reads back as built, with its txid', () => {
  const { lay, hex } = honest()
  const t = m.readTx(hex)
  assert.equal(t.inputs.length, 3)
  assert.equal(t.locktime, 0)
  assert.ok(t.inputs.every((i) => i.sequence === m.FINAL_SEQUENCE))
  assert.deepEqual(t.outputs.map((o) => [o.asset, o.value, o.script]), lay.outputs.map((o) => [o.asset, o.value, o.script]))
  assert.match(t.txid, /^[0-9a-f]{64}$/)
  // Witnesses do not move the txid.
  assert.equal(m.readTx(m.setWitnesses(hex, [['00'], [], ['11', '22']])).txid, t.txid)
})

test('the honest trade passes the check', () => {
  const { lay, hex, side } = honest()
  assert.equal(m.checkTrade(m.readTx(hex), lay.inputs, side), null)
})

test('the check refuses every way a trade can take from us', () => {
  const { lay, side } = honest()
  const t = (inputs, outputs, mod) => { const x = m.readTx(m.buildTx(inputs, outputs)); if (mod) mod(x); return x }
  // A lock time: a time-gated refund could share the trade.
  assert.match(m.checkTrade(t(lay.inputs, lay.outputs, (x) => { x.locktime = 5 }), lay.inputs, side), /lock time 5/)
  // An input signalling replacement.
  assert.match(m.checkTrade(t(lay.inputs, lay.outputs, (x) => { x.inputs[1].sequence = 0xfffffffd }), lay.inputs, side), /signals replacement/)
  // A coin of our wallet that we did not offer (the PV8 B1 shape).
  const extra = coin(9, B, 1000, CH)
  const s2 = { ...side, walletOwns: new Set([...side.walletOwns, `${extra.txid}:0`]) }
  assert.match(m.checkTrade(t([...lay.inputs, extra], lay.outputs), [...lay.inputs, extra], s2), /a coin of ours not offered/)
  // A coin at our enclave we did not offer.
  const encCoin = coin(8, A, 50, ENC)
  assert.match(m.checkTrade(t([...lay.inputs, encCoin], lay.outputs), [...lay.inputs, encCoin], side), /at a script of ours, not offered/)
  // Less of A delivered than agreed.
  const short = lay.outputs.map((o, i) => (i === 0 ? { ...o, value: 299n } : o))
  assert.match(m.checkTrade(t(lay.inputs, short), lay.inputs, side), /does not pay 300/)
  // More B taken than agreed: our change cut.
  const less = lay.outputs.map((o) => (o.script === CH && o.asset === B ? { ...o, value: o.value - 1n } : o))
  assert.match(m.checkTrade(t(lay.inputs, less), lay.inputs, side), /takes 501 of/)
  // The fee in two assets.
  const two = [...lay.outputs, { asset: B, value: 1n, script: '' }]
  assert.match(m.checkTrade(t(lay.inputs, two), lay.inputs, { ...side, gives: { ...side.gives, [B]: 501n } }), /in 2 assets/)
  // Below our fee floor.
  assert.match(m.checkTrade(t(lay.inputs, lay.outputs), lay.inputs, { ...side, feeFloor: () => 21n }), /below our floor of 21/)
  // A confidential output.
  assert.match(m.checkTrade(t(lay.inputs, lay.outputs, (x) => { x.outputs[1].nonce = '02' + '00'.repeat(32) }), lay.inputs, side), /confidential/)
  // A coin we offered left out.
  assert.match(m.checkTrade(t(lay.inputs.slice(0, 2), lay.outputs), lay.inputs.slice(0, 2), side), /leaves out coins we offered/)
})

test('a wallet that signed an input it did not offer is caught', () => {
  const { hex } = honest()
  const before = m.readTx(hex)
  const signed = m.readTx(m.setWitnesses(hex, [['aa'], ['bb', 'cc'], ['dd', 'ee']]))
  assert.equal(m.checkSigned(before, signed, [1, 2, 0]), null)
  assert.match(m.checkSigned(before, signed, [1, 2]), /would sign input 0/)
  assert.match(m.checkSigned(before, m.readTx(m.setWitnesses(hex, [[], ['bb'], []])), [1, 2]), /did not sign input 2/)
  const other = m.readTx(m.buildTx([coin(5, B, 1, CH)], [{ asset: B, value: 1n, script: '' }]))
  assert.match(m.checkSigned(before, other, [0]), /another transaction/)
})

test('the PSET carries the trade exactly (the wallet library reads it back, when built)', async (t) => {
  const pkg = process.env.SWK_PKG || './pkg'
  if (!fs.existsSync(pkg + '/lwk_wasm_bg.wasm')) { t.skip('pkg/ is not built here'); return }
  const w = await import(fs.realpathSync(pkg) + '/lwk_wasm.js')
  await w.default({ module_or_path: fs.readFileSync(pkg + '/lwk_wasm_bg.wasm') })
  const { lay, hex } = honest()
  const p = new w.Pset(m.psetOf(hex, lay.inputs))
  assert.equal(p.extractTx().toString(), hex)
})

test('the expiry digest is the tagged hash openampd checks', () => {
  // tagged_hash("openamp-dvp-v1", txid || be64(expires_at)), computed independently.
  const tag = createHash('sha256').update('openamp-dvp-v1').digest()
  const txid = '11'.repeat(32)
  const t = Buffer.alloc(8); t.writeBigUInt64BE(1794440000n)
  const want = createHash('sha256').update(Buffer.concat([tag, tag, Buffer.from(txid, 'hex'), t])).digest('hex')
  assert.equal(m.expiryDigest(txid, 1794440000), want)
})

const vectors = JSON.parse(fs.readFileSync(new URL('./restricted-offer-vectors.json', import.meta.url)))

test('offers of members 29 and 30, as the relay serves them, verify; a changed term does not', () => {
  for (const v of vectors) {
    const o = JSON.parse(JSON.stringify(v))
    seqob.normRelayOffer(o)
    assert.equal(seqob.verifyOffer(o), true, v.offer_id)
    const bad = JSON.parse(JSON.stringify(v))
    if (bad.restricted) bad.restricted.maker_aid = 'ff' + bad.restricted.maker_aid.slice(2)
    else bad.gated_order.rate_num = '1'
    seqob.normRelayOffer(bad)
    assert.equal(seqob.verifyOffer(bad), false, v.offer_id + ' changed')
  }
})

test('the book\'s restricted entries, either way, and never a bitcoin quote or an unverified offer', () => {
  const [rt, go] = vectors.map((v) => { const o = JSON.parse(JSON.stringify(v)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o) } })
  const a = rt.pair.base_asset; const b = rt.pair.quote_asset
  const buy = m.restrictedEntries([rt, go], { payAsset: b, receiveAsset: a })
  assert.deepEqual(buy.map((e) => [e.kind, e.rateNum, e.rateDen, e.whole]), [['dvp', 50000000n, 300n, true], ['gated', 2n, 1n, false]])
  assert.deepEqual(m.restrictedEntries([rt, go], { payAsset: a, receiveAsset: b }), [])
  const asBuyQuote = { ...rt, trade_dir: 'TRADE_DIR_BUY' }
  assert.equal(m.restrictedEntries([asBuyQuote], { payAsset: a, receiveAsset: b }).length, 1)
  assert.equal(m.restrictedEntries([{ ...rt, _verified: false }], { payAsset: b, receiveAsset: a }).length, 0)
  const btc = { ...rt, pair: { base_asset: a, quote_asset: 'BTC' } }
  assert.equal(m.restrictedEntries([btc], { payAsset: 'BTC', receiveAsset: a }).length, 0)
})

test('a gated fill pays its price rounded up and leaves no remainder below a lot', () => {
  const g = { rate_num: '3', rate_den: '2', min_lot: '10' }
  assert.deepEqual(m.gatedFill(g, 100n, 33n), { filled: 33n, required: 50n, remainder: 67n })
  assert.throws(() => m.gatedFill(g, 100n, 95n), /remainder below/)
  assert.throws(() => m.gatedFill(g, 100n, 5n), /below the order's least lot/)
  assert.deepEqual(m.gatedFill(g, 100n, 100n), { filled: 100n, required: 150n, remainder: 0n })
})

test('the approval card names whom to ask from the first source that exists, never a dead link', () => {
  const asset = { ticker: 'BOND', entity: { name: 'Registry Name', url: 'https://registry.example' }, domain: 'issuer.example' }
  const own = m.approvalCard({ eligible: false, code: 'category', onboarding: { name: 'Bond Issuer Ltd', url: 'https://bonds.example/apply' } }, asset, 'AID1')
  assert.equal(own.text, 'Only holders approved by Bond Issuer Ltd can hold BOND. Ask them to approve this wallet, then come back to buy.')
  assert.equal(own.link.url, 'https://bonds.example/apply')
  assert.equal(own.code, 'AID1')
  assert.equal(own.reason, m.RESTRICTED_WORDS.reasons.category)
  assert.equal(m.approvalCard({ eligible: false }, asset, 'x').link.url, 'https://issuer.example')
  assert.equal(m.approvalCard({ eligible: false }, { ...asset, domain: '' }, 'x').link.url, 'https://registry.example')
  const opOnly = m.approvalCard({ eligible: false, operator_onboarding: { name: 'Platform', url: 'https://platform.example' } }, { ticker: 'BOND' }, 'x')
  assert.equal(opOnly.link.url, 'https://platform.example')
  const none = m.approvalCard({ eligible: false, onboarding: { name: 'X', url: 'javascript:alert(1)' } }, { ticker: 'BOND' }, 'x')
  assert.equal(none.link, null)
  assert.equal(none.text, 'Only approved holders can hold BOND. Ask its issuer to approve this wallet and give them your approval code.')
})

test('bitcoin for a restricted asset: through an asset bitcoin buys, else the assets that buy it', () => {
  assert.deepEqual(m.btcRoute('BOND', [{ asset: 'x1' }, { asset: 'x2' }], (x) => x === 'x2'), { via: 'x2' })
  const card = m.btcRoute('BOND', [{ asset: 'x1' }, { asset: 'x2' }], () => false, (a) => a.toUpperCase()).card
  assert.deepEqual(card.choices, ['x1', 'x2'])
  assert.match(card.text, /BOND is bought with X1 or X2/)
  assert.equal(m.btcRoute('BOND', [], () => false).card.text, 'No one is selling BOND right now. Check back later.')
})

test('no word the default screen shows for a restricted trade is a forbidden one, and none says it cannot be traded', () => {
  const W = m.RESTRICTED_WORDS
  const texts = [W.approvalNamed('Issuer', 'BOND'), W.approvalUnnamed('BOND'), W.copyCode, W.openPage('Issuer'), ...Object.values(W.reasons),
    W.sellerHeld, W.btcVia('BOND', 'USDX'), W.btcOther('BOND', 'USDX'), W.btcViaSell('BOND', 'USDX'), W.btcOtherSell('BOND', 'USDX'),
    W.payWith('USDX'), W.getIn('USDX'), W.noneSelling('BOND'), W.noneBuying('BOND'), W.viaHeld('USDX'),
    ...Object.values(W.waits).flatMap((f) => [f('BOND', '12 Nov 2026'), f('BOND', null)])]
  for (const t of texts) {
    assert.deepEqual(forbiddenIn(t), [], t)
    assert.doesNotMatch(t, /can(no|')t be traded|not tradable|cannot trade/i, t)
  }
})

// A stand-in engine host for restrictedQuote.
function fakeR (over = {}) {
  const [rt, go] = vectors.map((v) => { const o = JSON.parse(JSON.stringify(v)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _status: { active_amount: '400' } } })
  const a = rt.pair.base_asset; const b = rt.pair.quote_asset
  return { a, b, R: { available: async () => true, isRestricted: (x) => x === a, book: async () => [rt, go], sellers: async () => [{ asset: b }], btcBuys: () => false,
    eligible: async () => null, held: async () => 10n ** 12n, feeAsset: async (p) => p, fee: async () => 7n, name: (x) => (x === a ? 'RSB' : 'USDX'), ...over } }
}

test('the engine: a restricted pair is priced from the book, the best of a whole quote and a gated order', async () => {
  const { a, b, R } = fakeR()
  // 50000000 B buys 300 by the maker's quote, or 400 (all the order holds) for 800 by the order.
  const q = await restrictedQuote(R, { payAsset: b, receiveAsset: a, amount: 50000000n })
  assert.equal(q.ok, true)
  assert.equal(q.ticket.amountOut, '400')
  assert.equal(q.ticket.amountIn, '800')
  assert.deepEqual(q.ticket.fees, [{ asset: b, atoms: '7' }])
  // Too little for any lot.
  assert.deepEqual(await restrictedQuote(R, { payAsset: b, receiveAsset: a, amount: 5n }), { ok: false, why: 'too-small' })
  // Not a restricted pair, or no policy server: the engine goes on as before.
  assert.equal(await restrictedQuote(R, { payAsset: b, receiveAsset: 'dd'.repeat(32), amount: 5n }), null)
  assert.equal(await restrictedQuote({ ...R, available: async () => false }, { payAsset: b, receiveAsset: a, amount: 5n }), null)
})

test('the engine: an unapproved buyer gets the approval card, whatever it pays with', async () => {
  const card = { text: 'Only approved holders can hold RSB.', code: 'AID' }
  const { a, b, R } = fakeR({ eligible: async () => card })
  assert.deepEqual(await restrictedQuote(R, { payAsset: b, receiveAsset: a, amount: 100n }), { ok: false, why: 'approval', card })
  assert.deepEqual(await restrictedQuote(R, { payAsset: 'BTC', receiveAsset: a, amount: 100n }), { ok: false, why: 'approval', card })
})

test('the engine: bitcoin for a restricted asset names the asset to go through, never a dead end', async () => {
  const { a, b, R } = fakeR()
  const q = await restrictedQuote(R, { payAsset: 'BTC', receiveAsset: a, amount: 100n })
  assert.equal(q.why, 'btc-route')
  assert.deepEqual(q.card.choices, [b])
  const via = await restrictedQuote({ ...R, btcBuys: () => true }, { payAsset: 'BTC', receiveAsset: a, amount: 100n })
  assert.equal(via.card.text, 'Bitcoin buys USDX, and USDX buys RSB. Get USDX first, then trade it for RSB.')
  assert.equal(via.card.side, 'get')
  const sell = await restrictedQuote(R, { payAsset: a, receiveAsset: 'BTC', amount: 100n })
  assert.match(sell.card.text, /^RSB is sold for USDX/)
  const none = await restrictedQuote({ ...R, sellers: async () => [] }, { payAsset: 'BTC', receiveAsset: a, amount: 100n })
  assert.equal(none.card.text, 'No one is selling RSB right now. Check back later.')
})

// A stand-in host and maker for takeDvP: the maker answers as told.
function dvpRig (maker) {
  const [rt] = vectors.map((v) => { const o = JSON.parse(JSON.stringify(v)); seqob.normRelayOffer(o); return { ...o, _verified: true } })
  const a = rt.pair.base_asset; const b = rt.pair.quote_asset
  const entry = m.restrictedEntries([rt], { payAsset: b, receiveAsset: a })[0]
  const mine = [coin(2, b, 60000000, CH), coin(3, F, 1000, CH)]
  const seen = { signed: 0, cosigned: 0 }
  const host = {
    policy: () => ({ asset: async () => ({ policy_pub: '22'.repeat(32), enforcement: 'cosign' }), enclaveScript: async () => MENC,
      check: async () => ({ ok: true }), cosign: async (b) => { seen.cosigned++; seen.body = b; return { txid: m.readTx(b.tx).txid } } }),
    aid: () => 'AID', enclave: async () => ({ script: ENC }), enclaveCoins: async () => [],
    walletCoins: async (asset) => mine.filter((c) => c.asset === asset), walletOwns: async () => new Set(mine.map((c) => `${c.txid}:0`)),
    coinsAt: async (ops) => ops.map((o) => (o.txid === mine[0].txid ? mine[0] : coin(1, a, 300, MENC))),
    newScript: async () => CH, scriptOf: async () => MREC, feeAtoms: async () => 20n, build: async (i, o) => { seen.built = m.buildTx(i, o); return seen.built },
    signWallet: async (hex) => { seen.signed++; const t = m.readTx(hex); return m.setWitnesses(hex, t.inputs.map((_, i) => (i === 0 ? [] : ['30', '02']))) },
    now: () => 1000,
    courier: async () => {
      const q = []
      return { send: async (msg) => { q.push(...maker(msg)) }, recv: async (type) => { const x = q.shift(); if (!x || x.type !== type) throw new Error('refused: no ' + type); return x }, fail: async () => {}, close () {} }
    },
  }
  return { host, entry, seen, mine }
}

test('the taker refuses a maker that names a coin of ours, before signing anything', async () => {
  const { host, entry, seen, mine } = dvpRig((msg) => (msg.type === 'dvp_request' ? [{ type: 'dvp_coins', dvp_coins: [{ Txid: mine[0].txid, Vout: 0 }] }] : []))
  await assert.rejects(m.takeDvP(host, entry, { feeAsset: F }), /a coin of ours/)
  assert.equal(seen.signed, 0)
  assert.equal(seen.cosigned, 0)
})

test('the taker refuses a maker whose signatures have expired, and one whose policy key is not the server\'s', async () => {
  const ok = (msg) => (msg.type === 'dvp_request' ? [{ type: 'dvp_coins', dvp_coins: [{ Txid: '01'.repeat(32), Vout: 0 }] }]
    : msg.type === 'dvp_tx' ? [{ type: 'dvp_signed', user_sigs: { 0: 'aa' }, expires_at: 999, expiry_sig: 'bb' }] : [])
  const r = dvpRig(ok)
  await assert.rejects(m.takeDvP(r.host, r.entry, { feeAsset: F }), /already expired/)
  assert.equal(r.seen.cosigned, 0)
  const r2 = dvpRig(ok)
  r2.host.policy = () => ({ asset: async () => ({ policy_pub: '33'.repeat(32) }) })
  await assert.rejects(m.takeDvP(r2.host, r2.entry, { feeAsset: F }), /policy key is not the one/)
  const r3 = dvpRig(ok)
  r3.host.policy = () => ({ asset: async () => ({ policy_pub: '22'.repeat(32), enforcement: 'damp' }) })
  await assert.rejects(m.takeDvP(r3.host, r3.entry, { feeAsset: F }), /not one its policy server co-signs/)
})

test('the taker refuses a trade its wallet signed beyond what it offered', async () => {
  const ok = (msg) => (msg.type === 'dvp_request' ? [{ type: 'dvp_coins', dvp_coins: [{ Txid: '01'.repeat(32), Vout: 0 }] }]
    : msg.type === 'dvp_tx' ? [{ type: 'dvp_signed', user_sigs: { 0: 'aa' }, expires_at: 99999, expiry_sig: 'bb' }] : [])
  const r = dvpRig(ok)
  // The wallet signs the maker's enclave input too.
  r.host.signWallet = async (hex) => { const t = m.readTx(hex); return m.setWitnesses(hex, t.inputs.map(() => ['30'])) }
  await assert.rejects(m.takeDvP(r.host, r.entry, { feeAsset: F }), /would sign input 0/)
  assert.equal(r.seen.cosigned, 0)
  // Honest: broadcast through the policy server.
  const r2 = dvpRig(ok)
  assert.deepEqual(await m.takeDvP(r2.host, r2.entry, { feeAsset: F }), { txid: m.readTx(r2.seen.built).txid })
  assert.equal(r2.seen.cosigned, 1)
})

const makerSells = (expires) => (msg) => (msg.type === 'dvp_request' ? [{ type: 'dvp_coins', dvp_coins: [{ Txid: '01'.repeat(32), Vout: 0 }] }]
  : msg.type === 'dvp_tx' ? [{ type: 'dvp_signed', user_sigs: { 0: 'aa' }, expires_at: expires, expiry_sig: 'bb' }] : [])

test('the trade\'s own txid is recorded before its broadcast: a lost answer, or one naming another transaction, is followed, never "nothing moved"', async () => {
  // A lost answer: the trade's txid was told first, and the error is not a refusal (the engine
  // follows the txid instead of calling the trade failed).
  const lost = dvpRig(makerSells(99999))
  let told = null
  lost.host.policy = ((p) => () => ({ ...p(), cosign: async () => { throw new Error('Failed to fetch') } }))(lost.host.policy)
  const e = await m.takeDvP(lost.host, lost.entry, { feeAsset: F, onTxid: (t) => { told = t } }).then(() => null, (x) => x)
  assert.match(String(e && e.message), /Failed to fetch/)
  assert.doesNotMatch(String(e.message), /^refused/)
  assert.equal(told, m.readTx(lost.seen.built).txid, 'the trade\'s txid, before the broadcast')
  // An answer naming another transaction is not taken for this trade's.
  const liar = dvpRig(makerSells(99999))
  liar.host.policy = ((p) => () => ({ ...p(), cosign: async () => ({ txid: 'de'.repeat(32) }) }))(liar.host.policy)
  let told2 = null
  await assert.rejects(m.takeDvP(liar.host, liar.entry, { feeAsset: F, onTxid: (t) => { told2 = t } }), /named another transaction/)
  assert.equal(told2, m.readTx(liar.seen.built).txid)
  // The engine keeps the txid it was told when the take throws after it.
  const rec = { ticket: { payAsset: 'p', receiveAsset: 'r' } }
  const R = { isRestricted: () => false, ensure: async () => {}, take: async (_e, o) => { o.onTxid('ab'.repeat(32)); throw new Error('Failed to fetch') } }
  await assert.rejects(restrictedConfirm(R, { entry: { id: 'x' }, give: 1n, receive: 1n, feeAsset: 'p', fee: 1n }, rec, (r) => r), /Failed to fetch/)
  assert.equal(rec.txid, 'ab'.repeat(32))
})

test('the expiry is reckoned on the later of the device clock and the chain\'s median time', async () => {
  // The device clock reads 1000, the chain 5000: a maker's signatures valid to 2000 have expired.
  const r = dvpRig(makerSells(2000))
  r.host.chainTime = async () => 5000
  await assert.rejects(m.takeDvP(r.host, r.entry, { feeAsset: F }), /already expired/)
  assert.equal(r.seen.cosigned, 0)
  // A chain the explorer cannot read leaves the device clock.
  const r2 = dvpRig(makerSells(2000))
  r2.host.chainTime = async () => { throw new Error('explorer: HTTP 502') }
  assert.equal((await m.takeDvP(r2.host, r2.entry, { feeAsset: F })).txid, m.readTx(r2.seen.built).txid)
})

test('only a refusal approval cures asks for approval; the others say what holds the trade, with its date', () => {
  const asset = { ticker: 'BOND', entity: { name: 'Bond Issuer Ltd', url: 'https://bonds.example' }, domain: '' }
  const now = () => Date.UTC(2026, 10, 12, 0, 0, 0)
  const card = (code, reason, height) => m.approvalCard({ eligible: false, code, reason, height, onboarding: { name: 'Bond Issuer Ltd', url: 'https://bonds.example/apply' } }, asset, 'AID1', { now })
  for (const code of ['unregistered', 'not_whitelisted', 'category', 'category_denied', 'frozen']) {
    const c = card(code)
    assert.match(c.text, /^Only holders approved by Bond Issuer Ltd/, code)
    assert.equal(c.code, 'AID1', code)
  }
  // 1440 blocks of 60 s: one day on.
  const lock = card('lockin', 'asset is locked in until height 2440 (current 1000)', 1000)
  assert.equal(lock.text, 'BOND can change hands from about 13 Nov 2026, as its issuer set.')
  const vest = card('vesting', 'vesting: 5 atoms locked until height 2440', 1000)
  assert.equal(vest.text, 'Part of this BOND is still vesting, until about 13 Nov 2026. Try a smaller amount, or come back then.')
  assert.equal(card('holder_cap', 'holder cap 5 would be exceeded (5 holders)').text, 'BOND has as many holders as its issuer allows right now. Come back later.')
  assert.equal(card('receive_window').text, 'This wallet can receive BOND from a later date, as its issuer set.')
  assert.equal(card('receive_window', 'this key may receive the asset from height 2440', 1000).text, 'This wallet can receive BOND from about 13 Nov 2026, as its issuer set.')
  assert.equal(card('rules', 'any').text, 'BOND\'s issuer does not allow this trade right now. Come back later.')
  assert.equal(card('sender_frozen').text, m.RESTRICTED_WORDS.sellerHeld)
  for (const code of ['lockin', 'vesting', 'holder_cap', 'receive_window', 'rules', 'limit', 'velocity', 'sender_frozen', 'sender_locked']) {
    const c = card(code)
    assert.equal(c.code, null, code)
    assert.equal(c.link, null, code)
    assert.doesNotMatch(c.text, /approv/i, code)
  }
})

test('bitcoin and a restricted asset: each leg read in the trade\'s own direction, never a route that does not exist', async () => {
  const { a, b, R } = fakeR()
  const asked = []
  // The book holds offers selling RSB for USDX only, and bitcoin buys USDX but USDX buys no bitcoin.
  const dirR = { ...R, sellers: async (_r, o = {}) => { asked.push(['sellers', !!o.sell]); return o.sell ? [] : [{ asset: b }] },
    btcBuys: (_x, o = {}) => { asked.push(['btcBuys', !!o.sell]); return !o.sell } }
  const sell = await restrictedQuote(dirR, { payAsset: a, receiveAsset: 'BTC', amount: 100n })
  assert.equal(sell.card.text, 'No one is buying RSB right now. Check back later.')
  assert.deepEqual(sell.card.choices, [])
  const buy = await restrictedQuote(dirR, { payAsset: 'BTC', receiveAsset: a, amount: 100n })
  assert.equal(buy.card.text, 'Bitcoin buys USDX, and USDX buys RSB. Get USDX first, then trade it for RSB.')
  assert.deepEqual(asked, [['sellers', true], ['sellers', false], ['btcBuys', false]])
})

test('the engine: money still on its way in is settled first and the trade priced again, never "you have none" (#691)', async () => {
  const { a, b, R } = fakeR({ held: async () => 0n, onItsWay: async (x) => (x === 'bb'.repeat(32) ? 0n : 10n ** 12n) })
  const q = await restrictedQuote(R, { payAsset: b, receiveAsset: a, amount: 50000000n })
  assert.deepEqual(q, { ok: false, why: 'settle-first', payAsset: b, coins: [], held: '0' })
  // Less on its way than the trade needs: none to trade.
  const poor = fakeR({ held: async () => 0n, onItsWay: async () => 10n })
  assert.deepEqual(await restrictedQuote(poor.R, { payAsset: poor.b, receiveAsset: poor.a, amount: 50000000n }), { ok: false, why: 'no-funds' })
})

test('the engine: what the trade must first move to the chain is on the ticket, its fee and its wait, before anything moves', async () => {
  const asked = []
  const { a, b, R } = fakeR({ moveQuote: async (needs) => { asked.push(needs); return { fees: [{ asset: needs[0].hex, atoms: 88n }], minutes: 4 } } })
  const q = await restrictedQuote(R, { payAsset: b, receiveAsset: a, amount: 50000000n })
  assert.equal(q.ok, true)
  assert.deepEqual(asked, [[{ hex: b, atoms: 807n }]], 'the move of what the trade pays, its fee included')
  assert.deepEqual(q.ticket.fees, [{ asset: b, atoms: '7' }, { asset: b, atoms: '88' }])
  assert.equal(q.ticket.minutes, 6)
  assert.deepEqual(q.choice.moveFees, [{ asset: b, atoms: 88n }])
  const { forbiddenIn } = await import('./user-trade.js')
  assert.deepEqual(forbiddenIn(m.RESTRICTED_WORDS.takes(6)), [])
  // Nothing to move: no wait on the ticket.
  const none = await restrictedQuote({ ...R, moveQuote: async () => null }, { payAsset: b, receiveAsset: a, amount: 50000000n })
  assert.equal(none.ticket.minutes, undefined); assert.equal(none.ticket.fees.length, 1)
  // Coins that must go through a round before they can move: settled first, as any trade.
  const sf = await restrictedQuote({ ...R, moveQuote: async () => { const e = new Error('settle first'); e.kind = 'settle_first'; e.coins = ['c1']; throw e } }, { payAsset: b, receiveAsset: a, amount: 50000000n })
  assert.deepEqual(sf, { ok: false, why: 'settle-first', payAsset: b, coins: ['c1'], held: '0' })
  // A move whose fee the wallet cannot also pay: none to trade.
  const tight = fakeR({ held: async () => 807n, moveQuote: async () => ({ fees: [{ asset: 'x', atoms: 0n }, { asset: b, atoms: 88n }], minutes: 4 }) })
  assert.deepEqual(await restrictedQuote(tight.R, { payAsset: tight.b, receiveAsset: tight.a, amount: 50000000n }), { ok: false, why: 'no-funds' })
})
