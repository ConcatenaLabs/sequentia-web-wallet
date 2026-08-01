// Rail-blind composer tests (spec §1 + §2), headless (a tiny DOM shim, no browser):
//   1. a Lightning-pay BUY matches the SAME resting offer + fill as an on-chain-pay BUY — the rail is a pure
//      settlement preference, it never changes which liquidity exists (bridgedTakePlan is rail-blind).
//   2. a request BELOW an offer's min_fill keeps PAY and RECEIVE consistent (both the minimum, a real placeable
//      take), shows the true minimum plainly, and BLOCKS Place (renderMixedTake).
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

// The LSP unified-book feed the composer's loadBtcBook fetches (getUnifiedBook -> L.unifiedBook). Section 5
// sets it so a FULL requoteCross/requoteMixed drive reads the SAME resting liquidity on every rail.
let UNIFIED_FEED = null;
const XROUTE = { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) };

const swap = await import('./swap.js');
// A build that CAN settle a sub-asset buy. subAssetBuySupported() is the single predicate
// the composer's Place gate and startBuy both read, so without these stubs every chain/ln
// case here would be gated on capability rather than on the matching logic under test.
// They are presence-only: nothing in this file executes a settlement.
const SUBAS_CAPABLE = {
  btcLeg: { fund: async () => ({}), refund: async () => ({}), refundKey: () => ({}), tipHeight: async () => 0 },
  seqLeg: { fund: async () => ({}), refund: async () => ({}), refundKey: () => ({}), claim: async () => ({}),
    claimKey: () => ({}), readOutput: async () => null, findFundingByAddress: async () => null },
  wasm: { generateSwapSecret: () => ({ secret_hex: '00'.repeat(32), hash_hex: '11'.repeat(32) }),
          buildSeqHtlcRedeemScript: () => '00' },
};
swap.initSwap({ ...C, ...SUBAS_CAPABLE, xroute: XROUTE,
  ln: { available: () => true, deployed: () => true, status: async () => ({ channels: [] }),
        unifiedBook: async () => UNIFIED_FEED,
        // the sub-asset-buy half of the LN bridge (L = ctx.ln)
        swap: async () => ({}), assetNodeKey: async () => 'k', nodeInvoice: async () => ({}),
        invoiceStatus: async () => ({}), nodeSettle: async () => ({}) } });
const T = swap.__test__;
const S = T.state;

// A rail-blind unified book with ONE resting on-chain ASK: a maker sells 1000 GOLD for 500 sats (price 0.5
// sats/atom). A taker BUYS from it regardless of the rail they pay with.
const askRaw = { want_asset: 'BTC', offer_amount: 1000, want_amount: 500, base_amount: 1000,
  offer_id: 'ask-1', maker_pubkey: '02'.padEnd(66, 'a') };
const ask = classifyRelayOffer(askRaw);
assert.ok(ask && ask.side === 'ask' && ask.assetAtoms === 1000 && ask.btcSats === 500, 'fixture: an on-chain ask (sell GOLD for BTC)');
T.setUnifiedBook(GOLD, { asks: [ask], bids: [] });

// ===========================================================================
// 1) RAIL-BLIND: a Lightning-pay buy matches the SAME offer + fill as an on-chain-pay buy.
// ===========================================================================
{
  const route = { seqAsset: GOLD, payIsBtc: true };   // a BUY (pay BTC, receive GOLD)
  S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRecvAmt.value = '400';   // the user wants 400 GOLD (the asset leg)

  // Pay BTC over LIGHTNING.
  S.payRail = 'ln'; S.recvRail = 'chain';
  const lnPlan = T.bridgedTakePlan(route);
  assert.ok(lnPlan && lnPlan.offer, 'Lightning-pay buy finds the resting offer (rail-blind book)');

  // Pay BTC ON-CHAIN — the SAME book, the SAME best offer, the SAME fill.
  S.payRail = 'chain'; S.recvRail = 'chain';
  const chainPlan = T.bridgedTakePlan(route);
  assert.ok(chainPlan && chainPlan.offer, 'on-chain-pay buy finds the resting offer (rail-blind book)');

  assert.equal(lnPlan.offer.id, chainPlan.offer.id, 'both rails match the SAME resting offer (rail-blind)');
  assert.equal(String(lnPlan.takeAtoms), String(chainPlan.takeAtoms), 'both rails fill the SAME asset amount');
  assert.equal(String(lnPlan.takeBtc), String(chainPlan.takeBtc), 'both rails fill the SAME BTC amount');
  // The fill is the requested 400 GOLD (a partial of the 1000 offer); BTC ceil-proportional (400*500/1000 = 200).
  assert.equal(String(lnPlan.takeAtoms), '400', 'the fill is the requested 400 GOLD (partial of a larger offer)');
  assert.equal(String(lnPlan.takeBtc), '200', 'the BTC is the ceil-proportional 200 sats');
  assert.equal(lnPlan.partial, true, 'it is a partial fill of the larger resting offer');
  console.log('ok: a Lightning-pay buy matches the SAME offer + fill as an on-chain-pay buy (rail-blind)');
}

// ===========================================================================
// 2) BELOW min_fill: keep pay/receive consistent, show the minimum, block Place.
// ===========================================================================
{
  const route = { seqAsset: GOLD, payIsBtc: true };   // a BUY
  S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
  S.payRail = 'ln'; S.recvRail = 'chain';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRate = mkEl('div'); REG.swReview = mkEl('button'); REG.swReview.disabled = false;
  REG.swRecvAmt.value = '50';   // 50 GOLD — BELOW this offer's 100-GOLD minimum

  // A resting offer of 1000 GOLD / 500 sats with a 100-GOLD minimum fill.
  const dec = T.renderMixedTake(route, { side: 'buy', offerAtoms: 1000, offerBtc: 500, minFill: 100 });

  assert.equal(dec.belowMin, true, 'a request under min_fill flags belowMin');
  // Pay & receive are CONSISTENT — both reflect the MINIMUM placeable take (100 GOLD for 50 sats), never the
  // whole offer, never a mismatched pair.
  assert.equal(REG.swRecvAmt.value, '100', 'the receive (GOLD) field shows the minimum 100 GOLD');
  assert.equal(REG.swPayAmt.value, '0.0000005', 'the pay (BTC) field shows the matching 50 sats — pay & receive agree');
  assert.equal(String(dec.takeAtoms), '100', 'the take is the minimum (a real placeable take), not the whole offer');
  assert.equal(String(dec.takeBtc), '50', 'the take BTC matches the minimum asset amount');
  // The true minimum is shown plainly.
  assert.match(REG.swRate.innerHTML, /smallest amount you can buy here is 100 GOLD \(0\.0000005 BTC\)/,
    'the composer shows the true minimum plainly');
  // Place is BLOCKED.
  assert.equal(REG.swReview.disabled, true, 'Place is blocked while the request is below the minimum');
  // A one-tap "use minimum" is offered (never leaves the user stuck).
  assert.match(REG.swRate.innerHTML, /Use minimum/, 'a one-tap "use minimum" is offered');
  console.log('ok: below min_fill keeps pay/receive consistent, shows the minimum, and blocks Place');
}

// ===========================================================================
// 3) UNIFIED BOOK across the composer rail COMBOS: an on-chain-pay buy (chain/chain) and a Lightning-pay
//    buy (ln/chain) of the SAME market + size — BOTH receiving the asset on-chain — match the SAME offer and
//    return the IDENTICAL takeAtoms/takeBtc from the ONE unified book. The rail combo ONLY selects the
//    invisible settlement dispatch: chain/chain is a happy coincidence (crosses:false -> the on-chain
//    courier); ln/chain crosses on the BTC leg (crosses:true -> the payer bridge). Same fill, different rail.
// ===========================================================================
{
  const route = { seqAsset: GOLD, payIsBtc: true };   // a BUY (pay BTC, receive GOLD)
  S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRecvAmt.value = '400';   // 400 GOLD, a partial of the 1000-GOLD offer

  // ON-CHAIN-PAY buy: pay BTC on-chain, receive GOLD on-chain (chain/chain).
  S.payRail = 'chain'; S.recvRail = 'chain';
  const onchainPay = T.bridgedTakePlan(route);
  assert.ok(onchainPay && onchainPay.offer, 'on-chain-pay buy matches the unified book');
  assert.equal(onchainPay.crosses, false, 'chain/chain is a happy coincidence -> settles via the on-chain courier (reviewCross)');

  // LIGHTNING-PAY buy: pay BTC over Lightning, receive GOLD on-chain (ln/chain) — SAME market + size.
  S.payRail = 'ln'; S.recvRail = 'chain';
  const lightningPay = T.bridgedTakePlan(route);
  assert.ok(lightningPay && lightningPay.offer, 'Lightning-pay buy matches the unified book');
  assert.equal(lightningPay.crosses, true, 'ln/chain crosses on the BTC leg -> settles via the payer bridge (reviewLspPayerBridge)');

  // The MATCH + FILL are identical across the two rail combos — one book, no per-rail divergence.
  assert.equal(onchainPay.offer.id, lightningPay.offer.id, 'both rail combos match the SAME resting offer');
  assert.equal(String(onchainPay.takeAtoms), String(lightningPay.takeAtoms), 'both rail combos fill the SAME asset amount from the unified book');
  assert.equal(String(onchainPay.takeBtc), String(lightningPay.takeBtc), 'both rail combos fill the SAME BTC amount from the unified book');
  assert.equal(String(onchainPay.takeAtoms), '400', 'the fill is the requested 400 GOLD (a partial of the larger offer), not the whole offer');
  assert.equal(String(onchainPay.takeBtc), '200', 'the BTC is the ceil-proportional 200 sats');
  assert.equal(onchainPay.partial, true, 'a partial fill of the larger resting offer (no whole-offer-only cross path)');
  console.log('ok: on-chain-pay and Lightning-pay buys of the same market+size share the SAME matched offer + fill (one unified book)');
}

// ===========================================================================
// 4) SUB-ASSET (LN-leg) best offer, RAIL-BLIND: when the best resting offer rests its ASSET over Lightning
//    (a sub-asset offer), BOTH an on-chain-pay buy (chain/chain) and a Lightning-pay buy (ln/chain) match the
//    SAME offer and render the IDENTICAL fill from the ONE unified book. bp.crosses is TRUE for both (the
//    on-chain courier cannot lift an LN-rested asset), so the composer shows the same fill on both rails and
//    only PLACE is gated — never a silent rail-siloed re-match to a different XBOOK offer.
// ===========================================================================
{
  // A sub-asset LN ask (ln_direction 4): asset leg over Lightning, BTC leg an on-chain HTLC. 1000 GOLD for
  // 600 sats (price 0.6). classifyRelayOffer tags it rail='ln'.
  const lnAskRaw = { lightning: { ln_direction: 4 }, offer_amount: 1000, want_amount: 600, base_amount: 1000,
    offer_id: 'ln-ask-1', maker_pubkey: '03'.padEnd(66, 'b') };
  const lnAsk = classifyRelayOffer(lnAskRaw);
  assert.ok(lnAsk && lnAsk.side === 'ask' && lnAsk.rail === 'ln' && lnAsk.assetAtoms === 1000 && lnAsk.btcSats === 600,
    'fixture: a sub-asset LN ask (asset leg over Lightning)');
  T.setUnifiedBook(GOLD, { asks: [lnAsk], bids: [] });

  const route = { seqAsset: GOLD, payIsBtc: true };   // a BUY (pay BTC, receive GOLD)
  S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRecvAmt.value = '400';   // 400 GOLD, a partial of the 1000-GOLD offer

  // ON-CHAIN-PAY buy (chain/chain): the asset leg rests over Lightning, so the on-chain courier crosses.
  S.payRail = 'chain'; S.recvRail = 'chain';
  const onchainPay = T.bridgedTakePlan(route);
  assert.ok(onchainPay && onchainPay.offer, 'on-chain-pay buy matches the sub-asset offer (rail-blind book)');
  assert.equal(onchainPay.offer.id, 'ln-ask-1', 'on-chain-pay buy matches the SUB-ASSET (LN-leg) best offer, not a different book');
  assert.equal(onchainPay.crosses, true, 'the asset rests over Lightning -> the on-chain courier crosses (Place is gated)');

  // LIGHTNING-PAY buy (ln/chain): SAME market + size.
  S.payRail = 'ln'; S.recvRail = 'chain';
  const lightningPay = T.bridgedTakePlan(route);
  assert.ok(lightningPay && lightningPay.offer, 'Lightning-pay buy matches the sub-asset offer (rail-blind book)');
  assert.equal(lightningPay.crosses, true, 'Lightning-pay buy also crosses on the LN-rested asset');

  // The MATCH + FILL are IDENTICAL across the two rail combos — one book, no per-rail divergence.
  assert.equal(onchainPay.offer.id, lightningPay.offer.id, 'both rail combos match the SAME sub-asset offer');
  assert.equal(String(onchainPay.takeAtoms), String(lightningPay.takeAtoms), 'both rail combos fill the SAME asset amount');
  assert.equal(String(onchainPay.takeBtc), String(lightningPay.takeBtc), 'both rail combos fill the SAME BTC amount');
  assert.equal(String(onchainPay.takeAtoms), '400', 'the fill is the requested 400 GOLD (a partial of the larger sub-asset offer)');
  assert.equal(String(onchainPay.takeBtc), '240', 'the BTC is the ceil-proportional 240 sats (400*600/1000)');

  // The RENDERED preview is the SAME on both rails: renderMixedTake paints identical pay/receive fields from
  // the SAME matched offer, regardless of the pay rail (the display never depends on the settlement path).
  const paint = (payRail) => {
    S.payRail = payRail; S.recvRail = 'chain';
    REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input'); REG.swRecvAmt.value = '400';
    const bp = T.bridgedTakePlan(route);
    const raw = bp.offer.raw || {};
    T.renderMixedTake(route, { side: 'buy', offerAtoms: bp.offer.assetAtoms, offerBtc: bp.offer.btcSats,
      minFill: BigInt(raw.min_fill || raw.minFill || 0) });
    return { pay: REG.swPayAmt.value, recv: REG.swRecvAmt.value };
  };
  const onchainPaint = paint('chain');
  const lightningPaint = paint('ln');
  assert.equal(onchainPaint.recv, lightningPaint.recv, 'the RECEIVE (GOLD) preview is identical on both rails');
  assert.equal(onchainPaint.pay, lightningPaint.pay, 'the PAY (BTC) preview is identical on both rails');
  assert.equal(onchainPaint.recv, '400', 'the receive preview is the requested 400 GOLD on both rails');
  assert.equal(onchainPaint.pay, '0.0000024', 'the pay preview is the ceil-proportional 240 sats on both rails');
  console.log('ok: a sub-asset (LN-leg) best offer renders the SAME matched offer + fill on both pay rails (Place gated, display rail-blind)');
}

// ===========================================================================
// 5) FULL COMPOSER DRIVE — chain/ln SUB-ASSET preview == chain/chain preview for the same market + size.
//    This exercises the REAL requote paths (requoteCross for chain/chain, requoteMixed's sub-asset branch for
//    chain/ln), not just the shared helpers, so a regression that reverts the sub-asset branch to
//    subassetOffers()[0] is CAUGHT: with NO sub-asset offer in the book but a resting offer in the unified
//    book, the sub-asset branch must STILL render the matched offer + fill from the unified book (identical to
//    chain/chain) and gate only Place — never silently show "No offers resting here yet".
// ===========================================================================
{
  // A plain on-chain ask: sell 1000 GOLD for 500 sats. It rests in the unified book; there is NO sub-asset
  // (LN-leg) offer for GOLD, so the sub-asset branch cannot source a fill from subassetOffers() — it MUST
  // read the unified book to render the same preview as chain/chain.
  const askRaw2 = { want_asset: 'BTC', offer_amount: 1000, want_amount: 500, base_amount: 1000,
    offer_id: 'ask-uni', maker_pubkey: '04'.padEnd(66, 'c') };
  const ask2 = classifyRelayOffer(askRaw2);
  UNIFIED_FEED = { ok: true, asks: [ask2], bids: [] };
  T.setSubassetBook(GOLD, null);   // ensure the sub-asset book is EMPTY for GOLD

  const drive = async (kind, payRail, recvRail) => {
    // Fresh composer fields each drive so a painted value is unambiguously from THIS drive.
    REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
    REG.swRecvAmt.value = '400';                         // want 400 GOLD (a partial of the 1000 offer)
    S.payAsset = 'BTC'; S.receiveAsset = GOLD; S.edited = 'receive';
    S.payRail = payRail; S.recvRail = recvRail; S.mode = 'take';
    const route = { seqAsset: GOLD, payIsBtc: true, payRail, recvRail, kind };
    if (kind === 'cross') await T.requoteCross(route, '400');
    else await T.requoteMixed(route, '400');
    return { pay: REG.swPayAmt.value, recv: REG.swRecvAmt.value };
  };

  // chain/chain BUY -> requoteCross (the on-chain courier settles a happy coincidence).
  const chainChain = await drive('cross', 'chain', 'chain');
  // chain/ln BUY (asset received over Lightning) -> requoteMixed's SUB-ASSET branch.
  const chainLn = await drive('mixed', 'chain', 'ln');

  assert.ok(chainChain.recv && chainChain.recv !== '', 'chain/chain painted a receive amount (matched the unified book)');
  assert.ok(chainLn.recv && chainLn.recv !== '', 'chain/ln SUB-ASSET painted a receive amount from the unified book (NOT "no offers")');
  assert.strictEqual(chainLn.recv, chainChain.recv, 'the RECEIVE (GOLD) preview is identical on chain/ln and chain/chain');
  assert.strictEqual(chainLn.pay, chainChain.pay, 'the PAY (BTC) preview is identical on chain/ln and chain/chain');
  // The concrete fill: 400 GOLD for ceil(400*500/1000) = 200 sats = 0.000002 BTC, on BOTH rails.
  assert.strictEqual(chainChain.recv, '400', 'the fill is the requested 400 GOLD (a partial of the larger offer)');
  assert.strictEqual(chainChain.pay, '0.000002', 'the BTC is the ceil-proportional 200 sats');
  console.log('ok: chain/ln SUB-ASSET and chain/chain render the IDENTICAL matched offer + fill via the ONE unified book (full requote drive)');
}

// ===========================================================================
// 6) SUB-ASSET BUY LIFTS THE SAME OFFER IT DISPLAYS (the shows-one-price/executes-another fix). The unified
//    best is a sub-asset LN offer; the sub-asset settlement book holds a DECOY at index 0 (a DIFFERENT id, a
//    DIFFERENT price) plus the matching offer. The composer must carry the SAME offer (by id) it priced and the
//    authoritative fill it showed — NEVER subassetOffers()[0] (the decoy), whose ratio would deliver a different
//    amount than displayed. Distinct asset hex so getUnifiedBook's per-asset cache doesn't return section 5's book.
// ===========================================================================
{
  const SILVER = 'bb'.repeat(32);
  // Unified best: a sub-asset LN ask (ln_direction 4), 1000 GOLD for 600 sats (price 0.6), id 'ln-ask-6'.
  const lnAskRaw = { lightning: { ln_direction: 4 }, offer_amount: 1000, want_amount: 600, base_amount: 1000,
    offer_id: 'ln-ask-6', maker_pubkey: '05'.padEnd(66, 'd') };
  const lnAsk = classifyRelayOffer(lnAskRaw);
  assert.ok(lnAsk && lnAsk.id === 'ln-ask-6' && lnAsk.rail === 'ln', 'fixture: a sub-asset LN ask (asset over Lightning)');
  UNIFIED_FEED = { ok: true, asks: [lnAsk], bids: [] };
  // Sub-asset settlement book: a DECOY at [0] priced 1.2 (1000 GOLD / 1200 sats) that the OLD code would have
  // lifted, then the MATCHING offer (same id + price as the displayed unified best).
  const decoy    = { offer_id: 'decoy-6',  asset_amount: 1000, btc_sats: 1200, min_fill: 0, maker_pubkey: '06'.padEnd(66,'e'), maker_claim_pub: '07'.padEnd(66,'f') };
  const matching = { offer_id: 'ln-ask-6', asset_amount: 1000, btc_sats: 600,  min_fill: 0, maker_pubkey: '05'.padEnd(66,'d'), maker_claim_pub: '08'.padEnd(66,'a') };
  T.setSubassetBook(SILVER, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [decoy, matching], ts: Date.now() });

  // Drive the REAL sub-asset branch: a chain/ln BUY (pay BTC on-chain, receive the asset over Lightning).
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input'); REG.swRecvAmt.value = '400';
  REG.swReview = mkEl('button'); REG.swReview.disabled = true; REG.swErr = mkEl('div');
  S.payAsset = 'BTC'; S.receiveAsset = SILVER; S.edited = 'receive'; S.mode = 'take';
  S.payRail = 'chain'; S.recvRail = 'ln';
  const route = { seqAsset: SILVER, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' };
  await T.requoteMixed(route, '400');

  // The DISPLAY prices the unified best (400 GOLD, a partial of 1000; BTC = ceil(400*600/1000) = 240).
  assert.equal(REG.swRecvAmt.value, '400', 'displays the requested 400 GOLD (partial of the 1000 sub-asset offer)');
  assert.equal(REG.swPayAmt.value, '0.0000024', 'displays the ceil-proportional 240 sats');

  const q = T.lastQuote();
  assert.ok(q && q.kind === 'mixed', 'a placeable mixed quote was produced');
  // The SETTLEMENT handle is the SAME offer the display priced (matched BY ID) — never the decoy at [0].
  assert.equal(q.buyOffer && q.buyOffer.offer_id, 'ln-ask-6', 'the settlement offer is the SAME id displayed (not subassetOffers()[0])');
  assert.notEqual(q.buyOffer && q.buyOffer.offer_id, 'decoy-6', 'the decoy (different-priced) offer at index 0 is NOT lifted');
  // The AUTHORITATIVE fill carried into startBuy == the displayed fill, so RECEIVE atoms at settlement == shown.
  assert.equal(q.takeAssetAtoms, '400', 'the authoritative asset fill == the displayed 400 GOLD (receive at settlement == display)');
  assert.equal(q.takeBtcSats, '240', 'the authoritative BTC fill == the displayed 240 sats');
  // startBuy lifts buyOffer with assetAtoms = expectedAssetAtoms; its defense-in-depth re-derives the maker's
  // ceil-proportional need for that fill and requires it match takeBtcSats within a sat — prove it holds here
  // (so the SAME 400 GOLD the user saw is delivered, and a mismatched offer would be refused pre-fund).
  const ceilDiv = (n, d) => (n + d - 1n) / d;
  const need = ceilDiv(BigInt(q.buyOffer.btc_sats) * BigInt(q.takeAssetAtoms), BigInt(q.buyOffer.asset_amount));
  assert.equal(String(need), q.takeBtcSats, 'the lifted offer prices the authoritative fill to the SAME BTC (defense-in-depth passes; settlement == display)');
  // The decoy, HAD it been lifted, would have delivered a DIFFERENT amount for the same 240 sats paid — proving
  // the fix matters (the old subassetOffers()[0] path is what showed 50 but delivered 25).
  const decoyDeliver = (BigInt(decoy.asset_amount) * BigInt(q.takeBtcSats)) / BigInt(decoy.btc_sats);
  assert.notEqual(String(decoyDeliver), q.takeAssetAtoms, 'the decoy offer would have delivered a DIFFERENT amount than displayed (regression guard)');
  console.log('ok: a chain/ln sub-asset BUY lifts the SAME offer id it displays; receive atoms at settlement == displayed fill');
}

// ===========================================================================
// 7) SUB-ASSET BUY BLOCKS PLACE WHEN THE UNIFIED BEST IS ON-CHAIN. The best resting offer is an on-chain maker
//    the sub-asset (asset-over-LN) path cannot deliver, so there is NO sub-asset offer to lift with its id. The
//    composer STILL shows the same fill, then DISABLES Place with the shared plain note — never lifts a DIFFERENT
//    (sub-asset) offer than shown, never gives rail advice. Mirrors requoteCross's show-fill-then-gate-Place.
// ===========================================================================
{
  const COPPER = 'cc'.repeat(32);
  // Unified best: a plain ON-CHAIN ask (want_asset 'BTC'), 1000 GOLD for 500 sats, id 'onchain-ask-7'.
  const ocAskRaw = { want_asset: 'BTC', offer_amount: 1000, want_amount: 500, base_amount: 1000,
    offer_id: 'onchain-ask-7', maker_pubkey: '09'.padEnd(66, 'b') };
  const ocAsk = classifyRelayOffer(ocAskRaw);
  assert.ok(ocAsk && ocAsk.rail === 'onchain', 'fixture: an on-chain ask (asset leg on-chain)');
  UNIFIED_FEED = { ok: true, asks: [ocAsk], bids: [] };
  // A sub-asset offer EXISTS but for a DIFFERENT id/price — the OLD code would have lifted it and enabled Place
  // at a price the user never saw. The fix finds NO offer whose id == the displayed on-chain best -> block Place.
  const other = { offer_id: 'other-7', asset_amount: 1000, btc_sats: 900, min_fill: 0, maker_pubkey: '0a'.padEnd(66,'c'), maker_claim_pub: '0b'.padEnd(66,'d') };
  T.setSubassetBook(COPPER, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [other], ts: Date.now() });

  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input'); REG.swRecvAmt.value = '400';
  REG.swReview = mkEl('button'); REG.swReview.disabled = false; REG.swErr = mkEl('div');
  S.payAsset = 'BTC'; S.receiveAsset = COPPER; S.edited = 'receive'; S.mode = 'take';
  S.payRail = 'chain'; S.recvRail = 'ln';
  const route = { seqAsset: COPPER, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' };
  await T.requoteMixed(route, '400');

  // THE INVARIANT THAT MATTERS IS "DISPLAYED == LIFTED", NOT "REFUSE".
  //
  // This used to show the on-chain best's fill and then disable Place, because no sub-asset
  // offer carried that id. That was safe but wrong in the same way the forward-cross branch
  // was: it refused a trade the sub-asset book could genuinely fill, one level down, with no
  // reason given. The remedy is not to lift a different offer than shown — it is to SHOW the
  // offer that can actually be lifted. So the quote re-renders against the sub-asset offer
  // and both the display and the settlement handle move to it together.
  //
  // 400 GOLD at the sub-asset offer's own ratio (900/1000) = ceil(400*900/1000) = 360 sats.
  assert.equal(REG.swRecvAmt.value, '400', 'the fill is shown (400 GOLD)');
  assert.equal(REG.swPayAmt.value, '0.0000036', 'the BTC shown is the SUB-ASSET offer price, not the on-chain best it cannot lift');
  const q = T.lastQuote();
  assert.ok(q, 'a placeable quote is produced against the offer this path can settle');
  assert.equal(String((q.buyOffer || {}).offer_id || ''), 'other-7', 'the settlement handle IS the displayed offer');
  assert.equal(REG.swReview.disabled, false, 'Place is enabled for a fill the sub-asset path can actually deliver');
  console.log('ok: a chain/ln sub-asset BUY re-quotes onto the offer it CAN lift, and displays that offer (displayed == lifted)');
}

// ===========================================================================
// 8) MIXED SAME-CHAIN (rails 7/8): an asset<->asset pair with one leg over Lightning drives
//    the SAME sub-asset branch with the QUOTE ASSET standing in BTC's structural place — the
//    fill renders in the quote's own units (never 'BTC'), the settlement handle is the pair's
//    book offer, and the quote carries the quoteAsset for the executors.
// ===========================================================================
{
  const TIN  = 'cd'.repeat(32);   // base
  const EURX = 'ce'.repeat(32);   // quote (numeraire)
  // The pair's sub-asset book: a dir-4 offer, 1000 TIN for 500,000,000 EURX atoms (5 EURX).
  const offer = { offer_id: 'mixed-8', asset_amount: 1000, btc_sats: 500000000, min_fill: 0,
    maker_pubkey: '09'.padEnd(66, 'b'), maker_claim_pub: '0a'.padEnd(66, 'c'), onchain_cltv: 144 };
  T.setSubassetBook(TIN, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [offer], ts: Date.now() }, EURX);
  UNIFIED_FEED = { ok: true, asks: [], bids: [] };   // no unified feed: the pair book IS the display

  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input'); REG.swRecvAmt.value = '400';
  REG.swReview = mkEl('button'); REG.swReview.disabled = true; REG.swErr = mkEl('div');
  S.payAsset = EURX; S.receiveAsset = TIN; S.edited = 'receive'; S.mode = 'take';
  S.payRail = 'chain'; S.recvRail = 'ln';
  const route = { kind: 'mixed', mixedSame: true, seqAsset: TIN, quoteAsset: EURX,
    payIsBtc: true, payRail: 'chain', recvRail: 'ln' };
  await T.requoteMixed(route, '400');

  // 400 TIN of the 1000 → ceil(400*500000000/1000) = 200,000,000 EURX atoms, rendered at the
  // QUOTE ASSET's own precision (this harness's assetMeta gives non-BTC assets precision 0, so
  // the atoms render verbatim) — NEVER the BTC 8-dp rendering ('2' with 1e8 scaling) the old
  // hard-coded quote produced.
  assert.equal(REG.swRecvAmt.value, '400', 'the base fill is shown (400 TIN)');
  assert.equal(REG.swPayAmt.value, '200000000', 'the pay side renders in the QUOTE asset\'s own units/precision, not BTC 8-dp');
  const q = T.lastQuote();
  assert.ok(q && q.kind === 'mixed', 'a placeable mixed same-chain quote was produced');
  assert.equal(String((q.buyOffer || {}).offer_id || ''), 'mixed-8', 'the settlement handle is the pair book\'s offer');
  assert.equal(q.route && q.route.quoteAsset, EURX, 'the quote asset rides the route for the executor');
  console.log('ok: a mixed same-chain BUY drives the sub-asset branch with the quote asset in BTC\'s place');
}

console.log('\nALL PASS');
