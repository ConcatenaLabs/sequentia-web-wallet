// PURE-LN PARTIAL FILLS in the composer (owner ruling: NOTHING is whole-fill).
//
// The Go protocol has carried asset-side slices end-to-end for a while (xpln
// -take-asset-msat; the maker re-rests the remainder) — the wallet was a layer
// that never passed the slice, so the pure-Lightning rails lifted the best
// resting offer IN FULL whatever the user typed. Headless (the tiny DOM shim,
// no browser), this file pins the closed gap:
//   1. plnSliceQuote is the EXACT mirror of the Go taker's rounding
//      (xdriver_pureln.go): BUY (taker GIVES BTC) floors the proportional quote
//      side at msat, SELL (taker RECEIVES BTC) ceils it — including the BigInt
//      edge where the two diverge at the sat level — and take >= offer collapses
//      to the whole offer exactly as the Go clamps it.
//   2. requoteLn sizes the take as min(typed, offer): a typed amount below the
//      offer prices a SLICE (LAST_QUOTE.takeAtoms + sliceQuoteAtoms, slice-truthful
//      rate line); typed >= offer keeps the unchanged whole-offer path; a
//      quote-side entry converts at the offer's exact ratio.
//   3. DUST is refused client-side before any POST (the Go driver would refuse
//      "prices to 0 msat"; we refuse the 0-atom display case too).
//   4. plnSwapBody — the ONE wire-body builder Review's confirm posts — carries
//      take_atoms only when a slice was priced (review == execution; whole-offer
//      bodies unchanged).
//
//   node --test swap-pureln-slice.test.mjs
import assert from 'node:assert';

// --- localStorage shim (swap.js reads/writes `localStorage` directly) --------------
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};

// --- a minimal DOM element + registry the ctx.$ resolves ---------------------------
function mkEl(tag = 'div') {
  const s = new Set();
  return {
    tag, innerHTML: '', textContent: '', title: '', disabled: false, id: '', value: '', style: {},
    children: [], onclick: null, dataset: {}, _userTyped: false, _refMode: false,
    classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { on ? s.add(c) : s.delete(c); }, contains: (c) => s.has(c) },
    appendChild(c){ this.children.push(c); return c; },
    querySelectorAll(){ return []; },
    addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){}, scrollIntoView(){},
  };
}
const REG = {};

// One asset per market, so the unified-book pair cache never bleeds between cases.
const GOLD  = 'aa'.repeat(32);   // 1000 GOLD / 500 sats     — the plain slice market
const EDGE  = 'bb'.repeat(32);   // 2000 EDGE / 3999 sats    — the floor/ceil sat-level edge
const DUSTQ = 'cc'.repeat(32);   // 2000 DUSTQ / 3 sats      — a slice's quote side rounds to 0
const DUSTA = 'dd'.repeat(32);   // 10 DUSTA / 5000 sats     — a typed-BTC entry converts to 0 atoms
const META = {
  BTC: { ticker: 'BTC', precision: 8 },
  [GOLD]: { ticker: 'GOLD', precision: 0 },
  [EDGE]: { ticker: 'EDGE', precision: 0 },
  [DUSTQ]: { ticker: 'DUSTQ', precision: 0 },
  [DUSTA]: { ticker: 'DUSTA', precision: 0 },
};

// --- fmtAtoms / parseAtoms (real integer<->decimal, so the painted fields are comparable) ---
function fmtAtoms(atoms, prec){
  atoms = BigInt(atoms); const neg = atoms < 0n; if (neg) atoms = -atoms;
  const s = atoms.toString().padStart((prec || 0) + 1, '0');
  const intPart = s.slice(0, s.length - (prec || 0)) || '0';
  let frac = prec ? s.slice(s.length - prec).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + intPart + (frac ? '.' + frac : '');
}
function parseAtoms(str, prec){
  const n = parseFloat(String(str == null ? '' : str).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error('bad amount');
  return BigInt(Math.round(n * Math.pow(10, prec || 0)));
}

const C = {
  $: (id) => REG[id] || (REG[id] = mkEl('div')),
  el: (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
  assetMeta: (h) => META[h] || { ticker: 'AST', precision: 0 },
  fmtAtoms, parseAtoms,
  assetAmountOf: (el) => (el && el.value) || '',
  refValueStr: () => '',
  wollet: { tip: () => ({ height: () => 300 }) },
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),
  registryAssets: () => [GOLD, EDGE, DUSTQ, DUSTA],
  balObj: () => ({}), btcBalance: 0,
};

// The LSP unified-book feed loadBtcBook fetches (per-asset, so each case has its own market).
let UNIFIED_FEED = null;
const XROUTE = { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) };

const swap = await import('./swap.js');
swap.initSwap({ ...C, xroute: XROUTE,
  ln: { available: () => true, deployed: () => true, status: async () => ({ channels: [] }),
        unifiedBook: async () => UNIFIED_FEED,
        swap: async () => ({}), assetNodeKey: async () => 'k', nodeInvoice: async () => ({}),
        invoiceStatus: async () => ({}), nodeSettle: async () => ({}) } });
const T = swap.__test__;
const S = T.state;

// A resting pure-LN offer as the unified book carries it (rail-tagged, price-ordered).
const pln = (id, assetAtoms, btcSats) =>
  ({ rail: 'pureln', assetAtoms, btcSats, id, maker: '02'.padEnd(66, 'a'), raw: {} });

// Drive the REAL pure-LN requote for one composer state.
async function quoteLn({ seqAsset, buy, edited, pay, recv, asks = [], bids = [] }){
  S.payAsset = buy ? 'BTC' : seqAsset; S.receiveAsset = buy ? seqAsset : 'BTC';
  S.payRail = 'ln'; S.recvRail = 'ln'; S.mode = 'take'; S.edited = edited;
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swPayAmt.value = pay || ''; REG.swRecvAmt.value = recv || '';
  UNIFIED_FEED = { ok: true, quote: 'BTC', asks, bids };
  const typed = edited === 'pay' ? (pay || '') : (recv || '');
  await T.requoteLn({ kind: 'ln', seqAsset, payIsBtc: buy, assetAsset: false }, typed);
  return T.lastQuote();
}

// ===========================================================================
// 1) plnSliceQuote — the exact Go rounding (floor on BUY, ceil on SELL, msat).
// ===========================================================================
{
  // Exact division: both sides agree (400 of 1000 GOLD at 500 sats -> 200 sats).
  const b = T.plnSliceQuote('buy', 400, 1000, 500);
  assert.deepEqual([b.whole, b.takeAtoms, b.quoteAtoms, b.quoteMsat, b.dust], [false, 400n, 200n, 200000n, false]);
  const s = T.plnSliceQuote('sell', 400, 1000, 500);
  assert.equal(s.quoteAtoms, 200n, 'an exact ratio prices the same both ways');

  // The BigInt edge where floor and ceil DIVERGE at the sat level: 1 of 2000 atoms
  // at 3999 sats = 1999.5 msat exactly. The BUY taker GIVES BTC and floors (1999
  // msat -> 1 sat); the SELL taker RECEIVES BTC and ceils (2000 msat -> 2 sats) —
  // sub-atom rounding always favors the maker, exactly as the Go does.
  const be = T.plnSliceQuote('buy', 1, 2000, 3999);
  assert.deepEqual([be.quoteMsat, be.quoteAtoms], [1999n, 1n], 'BUY floors the proportional msat');
  const se = T.plnSliceQuote('sell', 1, 2000, 3999);
  assert.deepEqual([se.quoteMsat, se.quoteAtoms], [2000n, 2n], 'SELL ceils the proportional msat');

  // Realistic-scale BigInt: the product overflows 2^53 (1e8 sats * 1.23e15 atoms * 1000).
  const big = T.plnSliceQuote('buy', 1234567890123457, 2100000000000000, 100000000);
  assert.deepEqual([big.quoteMsat, big.quoteAtoms], [58788947148n, 58788947n], 'the 128-bit-style product is exact');
  const bigS = T.plnSliceQuote('sell', 1234567890123457, 2100000000000000, 100000000);
  assert.equal(bigS.quoteMsat, 58788947149n, 'the sell ceil is one msat above the buy floor');

  // take >= the offer collapses to the WHOLE offer (the Go clamp).
  const w = T.plnSliceQuote('buy', 5000, 1000, 500);
  assert.deepEqual([w.whole, w.takeAtoms, w.quoteAtoms], [true, 1000n, 500n]);

  // Dust: a slice whose quote side prices to 0 (msat or displayed atoms).
  assert.equal(T.plnSliceQuote('buy', 1, 2000, 1).dust, true, '0 msat is dust (the Go refusal)');
  assert.equal(T.plnSliceQuote('buy', 1, 2000, 3).dust, true, 'sub-sat msat still displays 0 atoms — dust client-side');
  assert.equal(T.plnSliceQuote('buy', 0, 1000, 500), null, 'a zero take prices nothing');
  console.log('ok: plnSliceQuote mirrors the Go rounding (buy=floor, sell=ceil, BigInt, whole-clamp, dust)');
}

// ===========================================================================
// 2) requoteLn — min(typed, offer): a typed amount below the offer prices a SLICE.
// ===========================================================================
{
  const q = await quoteLn({ seqAsset: GOLD, buy: true, edited: 'receive', recv: '400',
    asks: [pln('pln-1', 1000, 500)] });
  assert.ok(q && q.kind === 'ln', 'a pure-LN quote is pinned');
  assert.equal(q.lnOffer.offer_id, 'pln-1', 'the priced offer is pinned for the settle');
  assert.equal(q.takeAtoms, 400n, 'the take is the TYPED 400 GOLD (min(typed, offer))');
  assert.equal(q.sliceQuoteAtoms, 200n, 'the BTC side is the offer-ratio slice (floor, per the Go)');
  assert.match(REG.swRate.innerHTML, /400 GOLD for 0\.000002 BTC/, 'the rate line shows the SLICE legs');
  assert.match(REG.swRate.innerHTML, /remainder stays on the book/, 'slice-truthful copy');
  assert.equal(REG.swReview.disabled, false, 'Review is offerable on a priced slice');
  console.log('ok: requoteLn prices the typed amount as a slice of the resting offer');
}

// ===========================================================================
// 3) requoteLn — typed >= the offer keeps the UNCHANGED whole-offer path.
// ===========================================================================
{
  const q = await quoteLn({ seqAsset: GOLD, buy: true, edited: 'receive', recv: '5000',
    asks: [pln('pln-1', 1000, 500)] });
  assert.equal(q.takeAtoms, null, 'typed >= offer -> the whole offer (no slice on the wire)');
  assert.equal(q.sliceQuoteAtoms, null);
  assert.match(REG.swRate.innerHTML, /1000 GOLD for 0\.000005 BTC · best resting offer/, 'the whole-offer line is unchanged');
  const body = T.plnSwapBody(q, 'nk', 'ck');
  assert.equal(body.take_atoms, undefined, 'the whole-offer body carries NO take_atoms (byte-identical)');

  // No amount typed at all: same unchanged whole-offer behavior.
  const q2 = await quoteLn({ seqAsset: GOLD, buy: true, edited: 'receive', recv: '',
    asks: [pln('pln-1', 1000, 500)] });
  assert.equal(q2.takeAtoms, null, 'no typed amount -> the whole offer, as before');
  console.log('ok: typed >= offer (and no amount) keep the unchanged whole-offer path');
}

// ===========================================================================
// 4) requoteLn — a QUOTE-side (BTC) entry converts at the offer's exact ratio.
// ===========================================================================
{
  const q = await quoteLn({ seqAsset: GOLD, buy: true, edited: 'pay', pay: '0.000002',
    asks: [pln('pln-1', 1000, 500)] });
  assert.equal(q.takeAtoms, 400n, '200 typed sats at 500 sats/1000 GOLD -> a 400-GOLD take');
  assert.equal(q.sliceQuoteAtoms, 200n, 'the priced BTC side round-trips the typed 200 sats');
  console.log('ok: a typed BTC amount converts to the asset take at the offer ratio');
}

// ===========================================================================
// 5) requoteLn — SELL ceils the received BTC (the Go divergence, via the full quote).
// ===========================================================================
{
  const q = await quoteLn({ seqAsset: EDGE, buy: false, edited: 'pay', pay: '1',
    bids: [pln('pln-edge', 2000, 3999)] });
  assert.equal(q.side, 'sell');
  assert.equal(q.takeAtoms, 1n);
  assert.equal(q.sliceQuoteAtoms, 2n, 'the SELL taker RECEIVES the ceil (2000 msat -> 2 sats), never the floor');
  console.log('ok: a sell slice ceils the proportional BTC side end-to-end');
}

// ===========================================================================
// 6) DUST is refused client-side, before any POST.
// ===========================================================================
{
  // (a) The slice's quote side prices to 0: 1 DUSTQ of 2000 at 3 sats = 1.5 msat -> 0 sats.
  const q = await quoteLn({ seqAsset: DUSTQ, buy: true, edited: 'receive', recv: '1',
    asks: [pln('pln-dq', 2000, 3)] });
  assert.equal(q, null, 'a dust slice pins NO quote (nothing to post)');
  assert.equal(REG.swReview.disabled, true, 'Review stays disabled on dust');
  assert.match(REG.swRate.textContent, /too small/, 'the refusal says why, honestly');

  // (b) A typed BTC amount that buys 0 atoms: 1 sat against 10 DUSTA / 5000 sats.
  const q2 = await quoteLn({ seqAsset: DUSTA, buy: true, edited: 'pay', pay: '0.00000001',
    asks: [pln('pln-da', 10, 5000)] });
  assert.equal(q2, null, 'a 0-atom conversion is refused, not silently promoted to the whole offer');
  assert.match(REG.swRate.textContent, /too small/);
  console.log('ok: dust slices are refused before the POST, with an honest message');
}

// ===========================================================================
// 7) plnSwapBody — review == execution on the wire.
// ===========================================================================
{
  const q = await quoteLn({ seqAsset: GOLD, buy: true, edited: 'receive', recv: '400',
    asks: [pln('pln-1', 1000, 500)] });
  const body = T.plnSwapBody(q, 'node-A', 'node-B');
  assert.equal(body.side, 'buy');
  assert.equal(body.asset, GOLD);
  assert.equal(body.take_atoms, 400, 'the priced slice rides the wire as take_atoms (asset atoms)');
  assert.equal(body.offer_id, 'pln-1', 'the reviewed offer is the lifted offer');
  assert.equal(body.node_key, 'node-A');
  assert.equal(body.counter_node_key, 'node-B');
  assert.equal(body.quote_asset, undefined, 'asset<->BTC implies BTC (body unchanged)');
  console.log('ok: plnSwapBody posts exactly the reviewed slice (take_atoms) with the pinned offer');
}

console.log('PASS swap-pureln-slice');
