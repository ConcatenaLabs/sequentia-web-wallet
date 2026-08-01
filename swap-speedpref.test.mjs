// Speed-aware selection preference (routing honesty; owner ruling), headless (a tiny DOM
// shim, no browser). A taker paying BTC over Lightning must never wait on Bitcoin
// confirmations when a maker that settles at Sequentia speed rests at the same price:
//   1. NATIVE WINS TIES: at an equal price the native-fast maker (P2P submarine / sub-asset)
//      is chosen over the bridged-slow (LSP maker-first) one, whatever the book's tie order.
//   2. BRIDGED WINS ONLY A STRICTLY BETTER PRICE — equal-or-worse loses to native.
//   3. The comparison runs on the EXECUTED amounts with the take's OWN proportional math
//      (sizeSubswapTake: ceil on a buy, floor on a sell) — never a different rounding, so a
//      raw-price edge that vanishes under the executed rounding does NOT flip the pick.
//   4. A fast candidate that cannot fill the executed take (its min_fill exceeds the want)
//      is not a candidate at all.
//   5. When the ONLY candidates are bridged-slow, the quote line itself carries the
//      Bitcoin-confirmation note BEFORE an amount is typed (never when a fast maker serves).
//   6. Drive-time label: front_mode/expected_wait off the LSP job response refine the status
//      line tolerantly; absent fields mean maker-first (slow).
import assert from 'node:assert';
import { classifyRelayOffer } from './tooling/lsp/unified-book.mjs';

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
const GOLD = 'aa'.repeat(32);

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
  assetMeta: (h) => (h === 'BTC' ? { ticker: 'BTC', precision: 8 } : { ticker: 'GOLD', precision: 0 }),
  fmtAtoms, parseAtoms,
  assetAmountOf: (el) => (el && el.value) || '',
  refValueStr: () => '',
  wollet: { tip: () => ({ height: () => 300 }) },
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),
  registryAssets: () => [GOLD],
  balObj: () => ({}), btcBalance: 0,
};

// The LSP unified-book feed loadBtcBook fetches for the requoteMixed drive (section 5).
let UNIFIED_FEED = null;
const XROUTE = { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) };

const swap = await import('./swap.js');
swap.initSwap({ ...C, xroute: XROUTE,
  ln: { available: () => true, deployed: () => true, status: async () => ({ channels: [] }),
        unifiedBook: async () => UNIFIED_FEED,
        // presence-only: the payer-bridge capability gate reads these; nothing here executes a settlement.
        swap: async () => ({}), bridgeHold: async () => ({}), nodePayHash: async () => ({}),
        assetNodeKey: async () => 'k', nodeInvoice: async () => ({}),
        invoiceStatus: async () => ({}), nodeSettle: async () => ({}) } });
const T = swap.__test__;
const S = T.state;

// --- fixtures: one maker of each speed class, at controllable prices ----------------------
// A bridged-slow candidate: a plain ON-CHAIN cross ask/bid (rail 'onchain'), settled for a
// Lightning-paying taker only by the LSP payer bridge (maker-first: a testnet4 wait).
const onchainAsk = (id, atoms, sats) => classifyRelayOffer({ want_asset: 'BTC', base_amount: atoms,
  offer_amount: atoms, want_amount: sats, offer_id: id, maker_pubkey: '02'.padEnd(66, 'a') });
const onchainBid = (id, atoms, sats) => classifyRelayOffer({ offer_asset: 'BTC', base_amount: atoms,
  want_amount: atoms, offer_amount: sats, offer_id: id, maker_pubkey: '02'.padEnd(66, 'a') });
// A native-fast candidate: an interactive SUBMARINE maker (asset on-chain, BTC over LN) —
// ln_direction 1 = ask (taker buys), 0 = bid (taker sells). Settles P2P at Sequentia speed.
const subAsk = (id, atoms, sats, extra) => classifyRelayOffer({ lightning: { ln_direction: 1 },
  base_amount: atoms, want_amount: sats, offer_id: id, maker_pubkey: '03'.padEnd(66, 'b'),
  maker_ln_node_pubkey: '02'.padEnd(66, 'c'), ...(extra || {}) });
const subBid = (id, atoms, sats) => classifyRelayOffer({ lightning: { ln_direction: 0 },
  base_amount: atoms, offer_amount: sats, offer_id: id, maker_pubkey: '03'.padEnd(66, 'b'),
  maker_ln_node_pubkey: '02'.padEnd(66, 'c') });

// Compose a BUY (pay BTC over Lightning, receive the asset on-chain) wanting 400 GOLD.
function planBuy(asks, want = '400'){
  S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
  S.payRail = 'ln'; S.recvRail = 'chain';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRecvAmt.value = want;
  T.setUnifiedBook(GOLD, { asks, bids: [] });
  return T.bridgedTakePlan({ seqAsset: GOLD, payIsBtc: true });
}
// Compose a SELL (pay the asset on-chain, receive BTC over Lightning) wanting 400 GOLD.
function planSell(bids, want = '400'){
  S.payAsset = GOLD; S.receiveAsset = 'BTC'; S.edited = 'pay';
  S.payRail = 'chain'; S.recvRail = 'ln';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swPayAmt.value = want;
  T.setUnifiedBook(GOLD, { asks: [], bids });
  return T.bridgedTakePlan({ seqAsset: GOLD, payIsBtc: false });
}

// ===========================================================================
// 1) NATIVE WINS TIES: equal price, the bridged offer sorted FIRST (id order, exactly how
//    mergeBook breaks a price tie) — the native submarine maker must still be chosen.
// ===========================================================================
{
  const oc = onchainAsk('a-oc', 1000, 500), sub = subAsk('z-sub', 1000, 500);
  assert.ok(oc.rail === 'onchain' && sub.rail === 'submarine', 'fixtures classify');
  const bp = planBuy([oc, sub]);   // book order: bridged first (the tie order that misrouted live)
  assert.ok(bp && bp.offer, 'a plan is produced');
  assert.equal(bp.offer.id, 'z-sub', 'the NATIVE (submarine) maker wins the price tie');
  assert.equal(bp.speedClass, 'fast', 'the chosen offer settles at Sequentia speed');
  assert.equal(bp.submarine, true, 'the settlement path is the P2P submarine (no bridge)');
  assert.equal(String(bp.takeAtoms), '400', 'the fill is the requested 400 GOLD');
  assert.equal(String(bp.takeBtc), '200', 'the BTC is the ceil-proportional 200 sats');
  console.log('ok: native-fast wins a price tie over bridged-slow, whatever the book tie order');
}

// ===========================================================================
// 2) BRIDGED WINS ONLY A STRICTLY BETTER PRICE.
// ===========================================================================
{
  // Strictly better (0.4 vs 0.5 sats/atom): the bridged offer is chosen, labeled slow, and
  // the fast alternative is recorded as available (the review still states the slow class).
  let bp = planBuy([onchainAsk('a-oc', 1000, 400), subAsk('z-sub', 1000, 500)]);
  assert.equal(bp.offer.id, 'a-oc', 'a STRICTLY better bridged price is taken');
  assert.equal(bp.speedClass, 'slow', 'and labeled slow');
  assert.equal(bp.fastAvailable, true, 'a fast candidate existed (so the quote line carries no only-slow note)');
  // Strictly worse (0.6): native wins.
  bp = planBuy([subAsk('a-sub', 1000, 500), onchainAsk('z-oc', 1000, 600)]);
  assert.equal(bp.offer.id, 'a-sub', 'a worse bridged price loses to native');
  assert.equal(bp.speedClass, 'fast');
  console.log('ok: a bridged offer is chosen over a native one ONLY for a strictly better price');
}

// ===========================================================================
// 3) EXECUTED-AMOUNT COMPARISON, THE TAKE'S OWN ROUNDING (buy = ceil). A raw-price edge of
//    0.999 vs 1.000 sats/atom VANISHES for a 400-atom take (ceil(400*999/1000) = 400 = the
//    native cost) — an executed TIE, so native wins. A comparison on the offers' raw prices
//    (or any other rounding) would have picked the bridged offer: that is the regression this
//    section pins. A real executed edge (990 -> 396 sats) still flips it.
// ===========================================================================
{
  let bp = planBuy([onchainAsk('a-oc', 1000, 999), subAsk('z-sub', 1000, 1000)]);
  assert.equal(bp.offer.id, 'z-sub', 'an executed-amount TIE (ceil eats the raw edge) goes to native');
  assert.equal(String(bp.takeBtc), '400', 'the executed cost is the native 400 sats');
  bp = planBuy([onchainAsk('a-oc', 1000, 990), subAsk('z-sub', 1000, 1000)]);
  assert.equal(bp.offer.id, 'a-oc', 'a genuine executed-amount edge (396 < 400 sats) takes the bridged offer');
  assert.equal(String(bp.takeBtc), '396', 'sized by the same ceil math the take uses');
  assert.equal(bp.speedClass, 'slow');
  console.log('ok: the buy comparison runs on executed amounts with the take\'s own ceil — never raw price');
}

// ===========================================================================
// 4) SELL MIRROR (floor): the taker RECEIVES the BTC leg, floored. 1001 sats raw > 1000, but
//    floor(400*1001/1000) = 400 = the native receive — an executed tie, native wins. 1010
//    (-> 404 received) is a genuine edge and takes the bridged bid.
// ===========================================================================
{
  let bp = planSell([onchainBid('a-oc', 1000, 1001), subBid('z-sub', 1000, 1000)]);
  assert.equal(bp.offer.id, 'z-sub', 'an executed-amount TIE (floor eats the raw edge) goes to native on a sell');
  assert.equal(String(bp.takeBtc), '400', 'the executed receive is the native 400 sats');
  bp = planSell([onchainBid('a-oc', 1000, 1010), subBid('z-sub', 1000, 1000)]);
  assert.equal(bp.offer.id, 'a-oc', 'a genuine executed edge (404 > 400 sats received) takes the bridged bid');
  assert.equal(String(bp.takeBtc), '404', 'sized by the same floor math the take uses');
  console.log('ok: the sell comparison mirrors with the take\'s own floor rounding');
}

// ===========================================================================
// 5) A FAST CANDIDATE THAT CANNOT FILL THE TAKE IS NOT A CANDIDATE: its min_fill exceeds the
//    want, so preferring it would force the below-minimum block on a trade the bridged offer
//    genuinely fills. The bridged offer stays chosen — and because no fast candidate could
//    fill, the plan reports only-slow (the quote line's note condition).
// ===========================================================================
{
  const bp = planBuy([onchainAsk('a-oc', 1000, 500), subAsk('z-sub', 1000, 500, { min_fill: 500 })]);
  assert.equal(bp.offer.id, 'a-oc', 'a fast maker whose minimum exceeds the want is passed over');
  assert.equal(bp.speedClass, 'slow');
  assert.equal(bp.fastAvailable, false, 'no fast candidate could fill -> only-slow is reported');
  console.log('ok: a fast candidate below-minimum for the want is not a candidate');
}

// ===========================================================================
// 6) QUOTE-LINE ONLY-SLOW NOTE (full requoteMixed drive, no amount typed): with ONLY bridged
//    candidates the rate line itself states the Bitcoin-confirmation class BEFORE an amount is
//    typed; with a fast maker at the same price it does not (the fast maker serves the take).
//    Distinct asset hexes so getUnifiedBook's pair cache never crosses the two drives.
// ===========================================================================
{
  const drive = async (assetHex, feedOffers) => {
    UNIFIED_FEED = { ok: true, asks: feedOffers, bids: [] };
    REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');   // NO amount typed
    REG.swRate = mkEl('div'); REG.swErr = mkEl('div'); REG.swReview = mkEl('button');
    S.payAsset = 'BTC'; S.receiveAsset = assetHex; S.edited = 'receive'; S.mode = 'take';
    S.payRail = 'ln'; S.recvRail = 'chain';
    const route = { seqAsset: assetHex, payIsBtc: true, payRail: 'ln', recvRail: 'chain', kind: 'mixed' };
    await T.requoteMixed(route, '');
    return REG.swRate.textContent;
  };
  const SLOWONLY = 'dd'.repeat(32);
  const slowLine = await drive(SLOWONLY, [classifyRelayOffer({ want_asset: 'BTC', base_amount: 1000,
    offer_amount: 1000, want_amount: 500, offer_id: 'oc-only', maker_pubkey: '04'.padEnd(66, 'd') })]);
  assert.match(slowLine, /waits on Bitcoin confirmations/i,
    'only bridged-slow candidates -> the quote line states the slow class before an amount is typed');
  const MIXEDBOOK = 'ee'.repeat(32);
  const fastLine = await drive(MIXEDBOOK, [
    classifyRelayOffer({ want_asset: 'BTC', base_amount: 1000, offer_amount: 1000, want_amount: 500,
      offer_id: 'a-oc', maker_pubkey: '04'.padEnd(66, 'd') }),
    classifyRelayOffer({ lightning: { ln_direction: 1 }, base_amount: 1000, want_amount: 500,
      offer_id: 'z-sub', maker_pubkey: '05'.padEnd(66, 'e'), maker_ln_node_pubkey: '02'.padEnd(66, 'f') }),
  ]);
  assert.ok(fastLine && fastLine.length, 'a price line rendered');
  assert.doesNotMatch(fastLine, /Bitcoin confirmations/i,
    'a fast maker at the same price serves the take -> no slow note on the quote line');
  console.log('ok: the quote line carries the slow-class note exactly when only bridged-slow candidates rest');
}

// ===========================================================================
// 7) DRIVE-TIME LABEL: front_mode/expected_wait are read tolerantly; ABSENT fields mean the
//    current maker-first behavior (slow).
// ===========================================================================
{
  const held = { kind: 'lsp-payer-buy', state: 'held' };
  assert.match(T.subswapStatusLine(held), /waits on Bitcoin confirmations/i, 'absent front_mode -> slow (maker-first)');
  assert.match(T.subswapStatusLine(held), /safe to leave/i, 'the slow label reassures: resumes + refunds automatically');
  assert.match(T.subswapStatusLine({ ...held, expected_wait: '~25 min' }), /~25 min/, 'expected_wait refines the estimate when present');
  assert.match(T.subswapStatusLine({ ...held, front_mode: 'inventory' }), /about a minute/i, "front_mode 'inventory' -> the fast label");
  assert.doesNotMatch(T.subswapStatusLine({ ...held, front_mode: 'inventory' }), /Bitcoin confirmations/i, 'the fast label carries no confirmation wait');
  assert.match(T.subswapStatusLine({ ...held, front_mode: 'maker-first' }), /waits on Bitcoin confirmations/i, "front_mode 'maker-first' stays slow");
  // A p2p record never gets the bridge refinement (it already settles at Sequentia speed).
  assert.doesNotMatch(T.subswapStatusLine({ kind: 'p2p-buy', state: 'held' }), /Bitcoin confirmations/i, 'the refinement is payer-bridge-only');
  console.log('ok: the drive-time status states the true pipeline; absent fields mean maker-first (slow)');
}

console.log('\nALL PASS');

// ===========================================================================
// 7) EXECUTABILITY BEFORE PRICE (the live GOLD-buy incident): a best-priced offer whose
//    crossing this build cannot settle for the chosen rails (asset-over-LN maker vs a
//    receive-on-chain taker) is NOT a candidate — the executable submarine maker one row
//    down is chosen, and the passed-over better price is flagged for the quote line.
// ===========================================================================
{
  const subasset = (id, atoms, sats) => classifyRelayOffer({ lightning: { ln_direction: 4 },
    base_amount: atoms, offer_amount: atoms, want_amount: sats, offer_id: id,
    maker_pubkey: '03'.padEnd(66, 'd'), maker_ln_node_pubkey: '02'.padEnd(66, 'e') });
  // Unexecutable best (0.4 sats/atom) vs executable submarine (0.5): the submarine wins.
  let bp = planBuy([subasset('a-sa', 1000, 400), subAsk('z-sub', 1000, 500)]);
  assert.ok(bp && bp.offer, 'a plan is produced');
  assert.equal(bp.offer.id, 'z-sub', 'the executable submarine maker is chosen over an unexecutable better price');
  assert.equal(bp.submarine, true, 'and settles P2P at Sequentia speed');
  assert.equal(bp.betterOtherRails, true, 'the passed-over better price is flagged for the quote line');
  // Equal executed price: still the submarine, but no better-price note.
  bp = planBuy([subasset('a-sa', 1000, 500), subAsk('z-sub', 1000, 500)]);
  assert.equal(bp.offer.id, 'z-sub');
  assert.equal(bp.betterOtherRails, false, 'an equal passed-over price is not called better');
  // ONLY the unexecutable offer rests: the plan keeps it so the dispatch refuses honestly.
  bp = planBuy([subasset('only-sa', 1000, 400)]);
  assert.ok(bp && bp.offer && bp.offer.id === 'only-sa', 'nothing executable -> the original pick survives');
  assert.ok(bp.crosses && !bp.supported, 'and downstream refuses it by name (crosses unsupported)');
  console.log('ok: executability precedes price; passed-over better prices are named, not hidden');
}
