// STALE-CAP FUND MISMATCH (fund-safety) + Use-minimum + history-upgrade regressions, headless
// (a tiny DOM shim, no browser). Reproduced live 2026-07-31: the sub-asset BUY quote line
// showed the maker's FRESH price while Confirm funded a STALE cached copy of the same offer,
// and the maker's exact-amount check refused AFTER the on-chain funding — sats stranded until
// the CLTV refund. Pinned here:
//   1. ONE SNAPSHOT: the offer the composer displays IS the offer it carries to startBuy —
//      when the unified-book copy and the sub-asset-book copy of the SAME offer id disagree,
//      the settlement copy feeds the display too (quote == fund, byte-for-byte).
//   2. QUOTE == FUND through the REAL startBuy: the sats handed to the on-chain fund equal
//      the sats the review displayed, exactly.
//   3. MUTATED BOOK AT CONFIRM REFUSES PRE-FUND: startBuy re-reads the live book once
//      immediately before the irreversible fund; a changed/gone offer refuses with nothing
//      funded (the honest "changed while you reviewed" message), never funding stale.
//   4. Task 19b: settle UPGRADES the fund-time '<QUOTE> locked' history row in place (the
//      quote-shape sub-asset BUY, end-to-end through startBuy on the seqLeg path).
//   5. Task 19a: the "Use minimum" link applies the minimum + re-quotes into a placeable
//      order, via the DELEGATED persistent handler (survives anchor repaints).
//   6. logTrade upgrade semantics: same-id re-log replaces only when flagged.
import assert from 'node:assert';
import { classifyRelayOffer } from './tooling/lsp/unified-book.mjs';

// --- localStorage + document shims (swap.js reads both directly) -------------------
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};
function mkEl(tag = 'div') {
  const s = new Set();
  return {
    tag, innerHTML: '', textContent: '', title: '', disabled: false, id: '', value: '', style: {},
    children: [], onclick: null, dataset: {}, _userTyped: false, _refMode: false,
    classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { (on === undefined ? !s.has(c) : on) ? s.add(c) : s.delete(c); }, contains: (c) => s.has(c) },
    appendChild(c){ this.children.push(c); return c; },
    remove(){}, querySelectorAll(){ return []; }, querySelector(){ return null; },
    addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){}, scrollIntoView(){},
  };
}
globalThis.document = { body: mkEl('body'), activeElement: null, querySelector: () => null };

const REG = {};
const GOLD = 'aa'.repeat(32);
const TIN  = 'cd'.repeat(32);   // mixed same-chain base
const EURX = 'ce'.repeat(32);   // mixed same-chain quote

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
const TICKERS = { [GOLD]: 'GOLD', [TIN]: 'TIN', [EURX]: 'EURX' };
const C = {
  $: (id) => REG[id] || (REG[id] = mkEl('div')),
  el: (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
  assetMeta: (h) => (h === 'BTC' ? { ticker: 'BTC', precision: 8 } : { ticker: TICKERS[h] || 'ASSET', precision: 0 }),
  fmtAtoms, parseAtoms,
  assetAmountOf: (el) => (el && el.value) || '',
  refValueStr: () => '',
  wollet: { tip: () => ({ height: () => 300 }) },
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),
  registryAssets: () => [GOLD, TIN, EURX],
  balObj: () => ({}), btcBalance: 0,
};

// --- controllable capability stubs -------------------------------------------------
let UNIFIED_FEED = null;
let LIVE_BOOKS = {};            // pairKey (asset|quote) -> the L.book (relay) response, the PRE-FUND re-read
let FUNDED = [];                // every on-chain fund the executor performed: { leg, amount }
let INVOICE = { held: true };   // L.invoiceStatus response (drives driveBuy to settle)
const bookKey = (a, q) => String(a).toLowerCase() + '|' + String(q || 'BTC').toLowerCase();
const XROUTE = { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) };
const SUBAS_CAPABLE = {
  btcLeg: {
    fund: async (redeem, amount, onBroadcast) => { FUNDED.push({ leg: 'btc', amount: Number(amount) });
      if (onBroadcast) onBroadcast('btctx1'); return { txid: 'btctx1', vout: 0 }; },
    refund: async () => 'rf', refundKey: () => ({ public_key: '02'.padEnd(66, '9'), secret_hex: '11'.repeat(32) }),
    tipHeight: async () => 100,
  },
  seqLeg: {
    fund: async (redeem, asset, amount) => { FUNDED.push({ leg: 'seq', amount: Number(amount) }); return { txid: 'seqtx1' }; },
    refund: async () => 'rf', refundKey: () => ({ public_key: '02'.padEnd(66, '8'), secret_hex: '22'.repeat(32) }),
    claim: async () => 'cl', claimKey: () => ({ public_key: '02'.padEnd(66, '7'), secret_hex: '33'.repeat(32) }),
    readOutput: async () => null,
    findFundingByAddress: async () => ({ txid: 'seqtx1', vout: 1 }),
  },
  wasm: { generateSwapSecret: () => ({ secret_hex: '00'.repeat(32), hash_hex: (Math.random().toString(16).slice(2) + '0'.repeat(64)).slice(0, 64) }),
          buildSeqHtlcRedeemScript: () => '00ff' },
};
const swap = await import('./swap.js');
swap.initSwap({ ...C, ...SUBAS_CAPABLE, xroute: XROUTE,
  ln: { available: () => true, deployed: () => true, status: async () => ({ channels: [] }),
        unifiedBook: async () => UNIFIED_FEED,
        book: async (asset, quote) => {
          const b = LIVE_BOOKS[bookKey(asset, quote)];
          if (!b) throw new Error('relay unreachable');
          return b;
        },
        swap: async () => ({ job_id: 'j1', poll: '/swap/j1' }),
        assetNodeKey: async () => 'nodekey',
        nodeInvoice: async () => ({ payment_hash: 'ph', hodl: true }),
        invoiceStatus: async () => INVOICE,
        nodeSettle: async () => ({ ok: true }) } });
const T = swap.__test__;
const S = T.state;
// The per-wallet history key's suffix depends on the harness (walletTag may hash a maker
// key); aggregate every history namespace so the assertions don't care.
const hist = () => {
  let out = [];
  for (const [k, v] of _ls){
    if (!k.startsWith('swk.dex.history')) continue;
    try { const arr = JSON.parse(v); if (Array.isArray(arr)) out = out.concat(arr); } catch {}
  }
  return out.filter(r => r && r.id);
};

// Drive the composer's sub-asset branch for a chain-pay / ln-receive BUY and return LAST_QUOTE.
async function quoteSubassetBuy(route, want){
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swRate = mkEl('div'); REG.swErr = mkEl('div');
  REG.swReview = mkEl('button'); REG.swReview.disabled = true;
  S.payAsset = route.mixedSame ? route.quoteAsset : 'BTC';
  S.receiveAsset = route.seqAsset; S.edited = 'receive'; S.mode = 'take';
  S.payRail = 'chain'; S.recvRail = 'ln';
  REG.swRecvAmt.value = want;
  await T.requoteMixed(route, want);
  return T.lastQuote();
}

// ===========================================================================
// 1) ONE SNAPSHOT: unified copy (fresh 6507) vs sub-asset copy (stale 6536) of the SAME
//    offer id. The display and the carried fill must BOTH come from the settlement copy —
//    never a fresh quote over a stale fund.
// ===========================================================================
{
  const uni = classifyRelayOffer({ lightning: { ln_direction: 4 }, offer_amount: 100000, want_amount: 6507,
    base_amount: 100000, offer_id: 'off-1', maker_pubkey: '03'.padEnd(66, 'b') });
  UNIFIED_FEED = { ok: true, asks: [uni], bids: [] };
  const staleCopy = { offer_id: 'off-1', asset_amount: 100000, btc_sats: 6536, min_fill: 0,
    maker_pubkey: '03'.padEnd(66, 'b'), maker_claim_pub: '02'.padEnd(66, 'c'), onchain_cltv: 144 };
  T.setSubassetBook(GOLD, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [staleCopy], ts: Date.now() });

  const q = await quoteSubassetBuy({ seqAsset: GOLD, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' }, '100000');
  assert.ok(q && q.buyOffer, 'a placeable quote with a settlement handle was produced');
  assert.equal(q.buyOffer.offer_id, 'off-1', 'the settlement handle is the displayed offer id');
  // The DISPLAY and the carried fill price from the SETTLEMENT copy (6536), not the unified 6507:
  // quote == fund byte-for-byte, and the pre-fund live re-read decides whether it is current.
  assert.equal(q.takeBtcSats, '6536', 'the carried BTC fill equals the settlement copy, not a different display copy');
  assert.equal(REG.swPayAmt.value, fmtAtoms(6536n, 8), 'the DISPLAYED pay amount equals the carried fill (one snapshot)');
  const ceilDiv = (n, d) => (n + d - 1n) / d;
  const need = ceilDiv(BigInt(q.buyOffer.btc_sats) * BigInt(q.takeAssetAtoms), BigInt(q.buyOffer.asset_amount));
  assert.equal(String(need), q.takeBtcSats, 'the carried fill prices exactly off the carried offer (defense-in-depth passes)');
  console.log('ok: display, carried fill and settlement handle are ONE snapshot when the caches disagree');
}

// ===========================================================================
// 2) QUOTE == FUND through the REAL startBuy (BTC shape), with the live book UNCHANGED:
//    the sats handed to the on-chain fund equal the sats the composer displayed, exactly.
// ===========================================================================
{
  const fresh = { offer_id: 'off-2', asset_amount: 100000, btc_sats: 6507, min_fill: 0,
    maker_pubkey: '03'.padEnd(66, 'b'), maker_claim_pub: '02'.padEnd(66, 'c'), onchain_cltv: 144 };
  const uni = classifyRelayOffer({ lightning: { ln_direction: 4 }, offer_amount: 100000, want_amount: 6507,
    base_amount: 100000, offer_id: 'off-2', maker_pubkey: '03'.padEnd(66, 'b') });
  UNIFIED_FEED = { ok: true, asks: [uni], bids: [] };
  T.setSubassetBook(GOLD, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [fresh], ts: Date.now() });
  LIVE_BOOKS = { [bookKey(GOLD, null)]: { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [fresh] } };
  FUNDED = []; INVOICE = { held: true };
  T.clearBuys();

  const q = await quoteSubassetBuy({ seqAsset: GOLD, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' }, '100000');
  assert.ok(q && q.buyOffer && q.buyOffer.offer_id === 'off-2', 'quote carries the reviewed offer');
  const displayedSats = BigInt(parseAtoms(REG.swPayAmt.value, 8));
  await T.startBuy({ asset: GOLD, amount: null, offer: q.buyOffer, quoteAsset: null,
    expectedAssetAtoms: q.takeAssetAtoms, expectedBtcSats: q.takeBtcSats });
  assert.equal(FUNDED.length, 1, 'exactly one on-chain fund');
  assert.equal(String(FUNDED[0].amount), String(displayedSats), 'FUNDED sats == DISPLAYED sats, byte-for-byte');
  assert.equal(String(FUNDED[0].amount), q.takeBtcSats, 'FUNDED sats == the carried reviewed fill');
  assert.equal(T.buys().length, 0, 'the settled buy record was cleared');
  const row = hist().find(r => r.id.startsWith('buy:'));
  assert.ok(row, 'a history row exists for the buy');
  assert.equal(row.title, 'Bought GOLD with BTC', 'the fund-time row was UPGRADED to the settled receipt');
  assert.equal(row.status, 'asset received');
  console.log('ok: the REAL startBuy funds exactly the displayed/reviewed sats, and the history row upgrades');
}

// ===========================================================================
// 3) MUTATED BOOK AT CONFIRM: the maker re-priced (same id, different sats) between review
//    and Confirm. startBuy's live pre-fund re-read must REFUSE with nothing funded.
//    Also: an offer GONE from the live book, and an unreachable relay, refuse the same way.
// ===========================================================================
{
  const reviewed = { offer_id: 'off-3', asset_amount: 100000, btc_sats: 6536, min_fill: 0,
    maker_pubkey: '03'.padEnd(66, 'b'), maker_claim_pub: '02'.padEnd(66, 'c'), onchain_cltv: 144 };
  const uni = classifyRelayOffer({ lightning: { ln_direction: 4 }, offer_amount: 100000, want_amount: 6536,
    base_amount: 100000, offer_id: 'off-3', maker_pubkey: '03'.padEnd(66, 'b') });
  UNIFIED_FEED = { ok: true, asks: [uni], bids: [] };
  T.setSubassetBook(GOLD, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [reviewed], ts: Date.now() });
  const q = await quoteSubassetBuy({ seqAsset: GOLD, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' }, '100000');
  assert.ok(q && q.buyOffer && q.buyOffer.offer_id === 'off-3', 'quote carries the reviewed offer');

  const drive = async (liveBook) => {
    LIVE_BOOKS = liveBook == null ? {} : { [bookKey(GOLD, null)]: liveBook };
    FUNDED = []; T.clearBuys();
    await T.startBuy({ asset: GOLD, amount: null, offer: q.buyOffer, quoteAsset: null,
      expectedAssetAtoms: q.takeAssetAtoms, expectedBtcSats: q.takeBtcSats });
    return REG.swErr.textContent;   // startBuy reports via its own modal; error text asserted below via FUNDED/records
  };

  // (a) price changed under the same id -> refuse, nothing funded, no record left behind.
  await drive({ sell_available: false, buy_available: true, sell_offers: [],
    buy_offers: [{ ...reviewed, btc_sats: 6507 }] });
  assert.equal(FUNDED.length, 0, 'a re-priced offer is refused BEFORE any funding');
  assert.equal(T.buys().length, 0, 'no orphaned buy record after the refusal');
  // (b) offer gone -> refuse pre-fund.
  await drive({ sell_available: false, buy_available: true, sell_offers: [], buy_offers: [] });
  assert.equal(FUNDED.length, 0, 'a vanished offer is refused BEFORE any funding');
  // (c) relay unreadable -> fail closed pre-fund (funding stale is the fund-loss; refusing loses nothing).
  await drive(null);
  assert.equal(FUNDED.length, 0, 'an unreadable live book fails closed BEFORE any funding');
  // The refusal message is the honest one.
  let msg = null;
  try { await T.reconfirmSubassetOffer(GOLD, 'buy', null, { ...reviewed }); } catch (e){ msg = e.message; }
  assert.match(String(msg), /changed while you reviewed/, 'the refusal says the offer changed while you reviewed');
  console.log('ok: a mutated/gone/unreadable book at Confirm refuses pre-fund — nothing is funded stale');
}

// ===========================================================================
// 4) QUOTE-SHAPE SETTLE UPGRADE (task 19b, end-to-end): a mixed same-chain sub-asset BUY
//    (pay EURX on-chain, receive TIN over LN) settles -> the 'EURX locked' row upgrades to
//    'Bought TIN with EURX' exactly as the BTC shape does.
// ===========================================================================
{
  const offer = { offer_id: 'mix-4', asset_amount: 1000, btc_sats: 500, min_fill: 0,
    maker_pubkey: '03'.padEnd(66, 'b'), maker_claim_pub: '02'.padEnd(66, 'c'), onchain_cltv: 144 };
  UNIFIED_FEED = { ok: true, asks: [], bids: [] };
  T.setSubassetBook(TIN, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [offer], ts: Date.now() }, EURX);
  LIVE_BOOKS = { [bookKey(TIN, EURX)]: { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [offer] } };
  FUNDED = []; INVOICE = { held: true };
  T.clearBuys();
  const route = { kind: 'mixed', mixedSame: true, seqAsset: TIN, quoteAsset: EURX,
    payIsBtc: true, payRail: 'chain', recvRail: 'ln' };
  const q = await quoteSubassetBuy(route, '1000');
  assert.ok(q && q.buyOffer && q.buyOffer.offer_id === 'mix-4', 'the pair-book offer is carried');
  await T.startBuy({ asset: TIN, amount: null, offer: q.buyOffer, quoteAsset: EURX,
    expectedAssetAtoms: q.takeAssetAtoms, expectedBtcSats: q.takeBtcSats });
  assert.equal(FUNDED.length, 1, 'the quote-asset leg was funded once');
  assert.equal(FUNDED[0].leg, 'seq', 'the mixed same-chain shape funds the Sequentia leg');
  assert.equal(String(FUNDED[0].amount), q.takeBtcSats, 'quote-shape FUNDED atoms == reviewed fill');
  const row = hist().find(r => r.title === 'Bought TIN with EURX');
  assert.ok(row, "the settled quote-shape row reads 'Bought TIN with EURX'");
  assert.equal(row.status, 'asset received', 'upgraded from the fund-time locked status');
  assert.ok(!hist().some(r => /EURX locked/.test(r.status)), "no row is left stuck at 'EURX locked'");
  console.log("ok: a settled quote-shape sub-asset BUY upgrades its row to 'Bought TIN with EURX'");
}

// ===========================================================================
// 5) USE MINIMUM (task 19a): below the offer minimum, the DELEGATED swusemin click applies
//    the minimum and re-quotes into a placeable order (fields = minimum, Place enabled).
// ===========================================================================
{
  const offer = { offer_id: 'min-5', asset_amount: 1000, btc_sats: 600, min_fill: 100,
    maker_pubkey: '03'.padEnd(66, 'b'), maker_claim_pub: '02'.padEnd(66, 'c'), onchain_cltv: 144 };
  const uni = classifyRelayOffer({ lightning: { ln_direction: 4 }, offer_amount: 1000, want_amount: 600,
    base_amount: 1000, offer_id: 'min-5', min_fill: 100, maker_pubkey: '03'.padEnd(66, 'b') });
  UNIFIED_FEED = { ok: true, asks: [uni], bids: [] };
  T.setSubassetBook(GOLD, { sell_available: false, buy_available: true, sell_offers: [], buy_offers: [offer], ts: Date.now() });
  const q0 = await quoteSubassetBuy({ seqAsset: GOLD, payIsBtc: true, payRail: 'chain', recvRail: 'ln', kind: 'mixed' }, '50');
  assert.equal(q0, null, 'below the minimum no placeable quote exists yet');
  assert.match(REG.swRate.innerHTML, /Use minimum/, 'the one-tap Use minimum is offered');
  assert.equal(typeof REG.swRate.onclick, 'function', 'the handler is DELEGATED on the persistent #swRate element');
  assert.equal(typeof REG.swRate._useMin, 'function', 'the current paint stored its action');
  // Click through the delegated path, exactly as a real click on the (possibly repainted) anchor lands.
  REG.swRate.onclick({ target: { closest: (sel) => sel === '.swusemin' ? {} : null }, preventDefault(){} });
  await new Promise(r => setTimeout(r, 80));   // the handler re-quotes async
  assert.equal(REG.swRecvAmt.value, '100', 'the minimum was applied to the asset field');
  const q1 = T.lastQuote();
  assert.ok(q1 && q1.kind === 'mixed', 'the re-quote produced a placeable order');
  assert.equal(q1.takeAssetAtoms, '100', 'the placeable order is exactly the minimum fill');
  assert.equal(REG.swReview.disabled, false, 'Place is enabled after Use minimum');
  console.log('ok: Use minimum applies the minimum via the delegated handler and enables Place');
}

// ===========================================================================
// 6) logTrade UPGRADE SEMANTICS: a same-id re-log replaces the row ONLY when flagged;
//    unflagged duplicates stay deduped (once per trade).
// ===========================================================================
{
  swap.logTrade({ id: 'up:1', title: 'Buying X with Y', status: 'Y locked' });
  swap.logTrade({ id: 'up:1', title: 'SHOULD NOT APPEAR', status: 'dup' });
  let rows = hist().filter(r => r.id === 'up:1');
  assert.equal(rows.length, 1, 'unflagged same-id re-log is deduped');
  assert.equal(rows[0].status, 'Y locked', 'the original row is untouched');
  swap.logTrade({ id: 'up:1', title: 'Bought X with Y', status: 'asset received', upgrade: true });
  rows = hist().filter(r => r.id === 'up:1');
  assert.equal(rows.length, 1, 'an upgrade replaces in place — never a duplicate row');
  assert.equal(rows[0].title, 'Bought X with Y', 'the upgraded title lands');
  assert.equal(rows[0].status, 'asset received', 'the upgraded status lands');
  console.log('ok: logTrade upgrades a row in place only when flagged');
}

// ===========================================================================
// 7) PAIR FLIP (task 20): the ⇅ control swaps the ASSETS, the per-leg RAILS and the typed
//    amounts (each amount rides with its asset), and flips which side counts as edited.
// ===========================================================================
{
  S.payAsset = 'BTC'; S.receiveAsset = GOLD;
  S.payRail = 'chain'; S.recvRail = 'ln'; S.edited = 'receive'; S.mode = 'take';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  REG.swPayAmt.value = '0.5'; REG.swRecvAmt.value = '100'; REG.swRecvAmt._userTyped = true;
  assert.equal(typeof REG.swFlip.onclick, 'function', 'the flip control is wired');
  REG.swFlip.onclick();
  assert.equal(S.payAsset, GOLD, 'pay asset flipped to the old receive asset');
  assert.equal(S.receiveAsset, 'BTC', 'receive asset flipped to the old pay asset');
  assert.equal(S.payRail, 'ln', 'the pay-leg rail followed its asset');
  assert.equal(S.recvRail, 'chain', 'the receive-leg rail followed its asset');
  assert.equal(REG.swPayAmt.value, '100', 'the typed amount rode WITH its asset to the pay field');
  assert.equal(REG.swRecvAmt.value, '0.5', 'the other amount rode with its asset too');
  assert.equal(S.edited, 'pay', 'the edited side flipped with the value it labels');
  console.log('ok: the flip swaps assets, rails and amounts coherently');
}

console.log('\nALL PASS');
