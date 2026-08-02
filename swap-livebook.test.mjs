// The same-chain ONE-book union discipline (the ladder-collapse fix), headless.
//
// LIVE REPRO THIS PINS (2026-08-01, GOLD/EURX): the relay's REST orderbook is liftable-filtered
// (server.go liftableOffers: a PLAIN interactive offer is hidden unless its maker's courier is
// connected) while its WS market_subscribe snapshot is NOT filtered — so REST said 2 offers and
// the WS snapshot said 42, and the wallet's ladder showed whichever source painted LAST. The
// pair-bar price flip re-ran the REST paint with no fresh snapshot to heal it, so the ladder
// collapsed and STAYED collapsed until a pair re-select re-subscribed.
//
// The fix: every ladder paint draws the UNION of the live WS map, the REST baseline and the LSP
// unified families (renderSameUnion), with per-market snapshot receipt, tombstones for WS
// removals, the relay's own ghost/liveness rule mirrored client-side, and an orientation-
// independent stream key — so the flip, the selector and every rail path render identical
// content, and no paint can regress the ladder below what the other sources know.
import test from 'node:test';
import assert from 'node:assert';

// --- document shim: the derived-field writers guard on document.activeElement ------
globalThis.document = { activeElement: null };

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

// Assets: 64-hex ids; a fresh QUOTE asset per test dodges the ~12s unified-book cache.
const GOLD = 'aa'.repeat(32);
const QA = (n) => n.toString(16).padStart(2, '0').repeat(32);

const BAL = {};   // hex -> atoms string (mutable per test)

const C = {
  $: (id) => REG[id] || (REG[id] = mkEl('div')),
  el: (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
  assetMeta: (h) => (h === 'BTC' ? { ticker: 'BTC', precision: 8 } : { ticker: 'T' + String(h).slice(0, 2).toUpperCase(), precision: 0 }),
  fmtAtoms, parseAtoms,
  assetAmountOf: (el) => (el && el.value) || '',
  refValueStr: () => '',
  wollet: { tip: () => ({ height: () => 300 }) },
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),
  registryAssets: () => [GOLD],
  balObj: () => BAL, btcBalance: 0,
  feeRateFor: () => 100000000n, DEFAULT_FEERATE: 1000, EXCHANGE_RATE_SCALE: 100000000,
};

let UNIFIED_FEED = null;   // what L.unifiedBook returns ({ ok, quote, asks, bids } | null)
const XROUTE = { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) };

const swap = await import('./swap.js');
swap.initSwap({ ...C, xroute: XROUTE,
  ln: { available: () => true, deployed: () => true, status: async () => ({ channels: [] }),
        unifiedBook: async () => UNIFIED_FEED,
        lnBook: async () => ({ buy_offers: [], sell_offers: [] }),
        book: async () => ({ sell_available: false, buy_available: false, sell_offers: [], buy_offers: [] }),
        swap: async () => ({}), bridgeHold: async () => ({}), nodePayHash: async () => ({}),
        assetNodeKey: async () => 'k', nodeInvoice: async () => ({}),
        invoiceStatus: async () => ({}), nodeSettle: async () => ({}) } });
const T = swap.__test__;
const S = T.state;

// --- scripted relay double (REST + WS), installed through the client seam ----------
let REST = {};        // 'base/quote' -> offers[]
const SOCKETS = [];   // every openRelay call
T.setSeqobClient({
  fetchBook: async (base, quote) => {
    return { pair: { base_asset: base, quote_asset: quote }, offers: (REST[base + '/' + quote] || []).map(o => ({ ...o })) };
  },
  openRelay: (markets, handlers) => {
    const s = { markets, handlers, resubs: [], closed: false,
      subscribe: (p) => s.resubs.push(p), post: () => {}, close: () => { s.closed = true; } };
    SOCKETS.push(s);
    if (handlers.onOpen) handlers.onOpen();
    return s;
  },
});
const ws = () => SOCKETS[SOCKETS.length - 1];

// --- fixtures ----------------------------------------------------------------------
const nowS = () => Math.floor(Date.now() / 1000);
let seq = 0;
// An offer in the relay wire shape. giveBase: gives BASE, wants QUOTE (an ask in the
// base/quote frame). Default price 1:1, created 2h ago (past the ghost grace), unexpired.
function offer(base, quote, giveBase, opts = {}){
  const id = opts.id || ('o' + (++seq));
  const off = String(opts.off ?? 100), want = String(opts.want ?? 100);
  return {
    offer_id: id, maker_pubkey: opts.maker || ('02'.padEnd(66, 'f')),
    offer_asset: giveBase ? base : quote, want_asset: giveBase ? quote : base,
    offer_amount: off, want_amount: want,
    base_amount: String(opts.baseAmt ?? (giveBase ? off : want)),
    pair: { base_asset: base, quote_asset: quote },
    created_at_unix: opts.created ?? (nowS() - 7200),
    expires_at_unix: opts.exp ?? (nowS() + 3600),
    _verified: true,
    ...(opts.covenant ? { covenant: { covenant_txid: 'ff'.repeat(32), rate_num: 1, rate_den: 1 } } : {}),
  };
}
const ids = (list) => new Set((list || []).map(o => String(o.offer_id || o.offerId)));

async function selectPair(pay, receive, opts = {}){
  S.payAsset = pay; S.receiveAsset = receive; S.priceFlip = false;
  S.payRail = 'chain'; S.recvRail = 'chain'; S.edited = 'pay'; S.mode = opts.mode || 'take';
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input');
  if (opts.pay != null) { REG.swPayAmt.value = String(opts.pay); REG.swPayAmt._userTyped = true; }
  if (opts.recv != null) { REG.swRecvAmt.value = String(opts.recv); REG.swRecvAmt._userTyped = true; }
  REG.swErr = mkEl(); REG.swRate = mkEl(); REG.swRoute = mkEl();
  T.stopLiveBook();
  await T.requoteSame({ kind: 'same', pay, receive }, '');
}

// ===================================================================================
// 1. THE LIVE COLLAPSE, PINNED: the flip's REST re-render must not clobber the richer
//    live-stream book, and flip-back must render the same full ladder.
// ===================================================================================
test('price flip never collapses the ladder below the live union (the GOLD/EURX repro)', async () => {
  const Q = QA(0xb1);   // pay GOLD -> receive Q: liftable rows give Q, want GOLD
  // REST (liftable-filtered, honest): ONE plain live ask + ONE plain bid.
  const liveAsk = offer(Q, GOLD, true, { id: 'live-ask' });
  const liveBid = offer(Q, GOLD, false, { id: 'live-bid' });
  REST = { [Q + '/' + GOLD]: [liveAsk, liveBid], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  assert.equal(T.book().offers.length, 1, 'REST-only paint: one liftable ask');

  // The WS snapshot (unfiltered) delivers a 40-row covenant book for the same market —
  // covenant offers settle with the maker offline, so ALL of them belong on the ladder.
  const covs = Array.from({ length: 40 }, (_, i) => offer(Q, GOLD, true, { id: 'cov' + i, covenant: true }));
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [liveAsk, ...covs] });
  T.flushLiveBook();
  assert.equal(T.book().offers.length, 41, 'snapshot heals the ladder to the full union');

  // FLIP the price direction: display-only, but it re-runs the REST quote — the bug clobbered
  // the 41-row book back to 1 here, persistently. The union render must keep all 41.
  S.priceFlip = true;
  await T.requoteSame({ kind: 'same', pay: GOLD, receive: Q }, '');
  assert.equal(T.book().offers.length, 41, 'flip re-render keeps the union');

  // Flip BACK: still the full ladder (the live repro stayed collapsed here).
  S.priceFlip = false;
  await T.requoteSame({ kind: 'same', pay: GOLD, receive: Q }, '');
  assert.equal(T.book().offers.length, 41, 'flip-back keeps the union');
  T.stopLiveBook();
});

// ===================================================================================
// 2. The task's scripted double, in the other direction: rich REST + a one-market,
//    one-offer WS snapshot. The stream rebuild must not clobber the REST book.
// ===================================================================================
test('a poor one-orientation WS snapshot never clobbers a rich REST book', async () => {
  const Q = QA(0xb2);
  const covs = Array.from({ length: 41 }, (_, i) => offer(Q, GOLD, true, { id: 'rc' + i, covenant: true }));
  REST = { [Q + '/' + GOLD]: covs, [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  assert.equal(T.book().offers.length, 41);

  // The stream (post-restart) has only ONE orientation's snapshot with ONE offer.
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [offer(Q, GOLD, true, { id: 'ws-only', covenant: true })] });
  T.flushLiveBook();
  assert.equal(T.book().offers.length, 42, 'rebuild is a union, not a replacement');
  // And the market whose snapshot never arrived is tracked as missing.
  assert.equal(T.liveBook().snaps.size, 1, 'only one market snapshot received');
  T.stopLiveBook();
});

// ===================================================================================
// 3. The relay's liveness rule, mirrored: a PLAIN interactive offer that the fresh
//    liftable-filtered REST baseline does not list, past the ghost grace, is
//    unfillable (no maker courier) and must not be advertised. Covenant and young
//    plain offers stay.
// ===================================================================================
test('WS-only plain ghosts are filtered; covenant and young plain offers are kept', async () => {
  const Q = QA(0xb3);
  const liveAsk = offer(Q, GOLD, true, { id: 'live' });
  REST = { [Q + '/' + GOLD]: [liveAsk], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);

  const ghosts = Array.from({ length: 40 }, (_, i) => offer(Q, GOLD, true, { id: 'ghost' + i }));  // plain, aged, not in REST
  const young = offer(Q, GOLD, true, { id: 'young', created: nowS() - 10 });                       // submit-then-connect grace
  const cov = offer(Q, GOLD, true, { id: 'cov', covenant: true });                                 // fills with maker offline
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [liveAsk, ...ghosts, young, cov] });
  T.flushLiveBook();
  const got = ids(T.book().offers);
  assert.ok(got.has('live') && got.has('young') && got.has('cov'), 'live + young + covenant advertised');
  assert.equal(got.size, 3, 'aged plain ghosts (unfillable) are not advertised');
  T.stopLiveBook();
});

// ===================================================================================
// 4. Tombstones: a WS removal must also suppress the stale REST copy of that offer.
// ===================================================================================
test('a WS removal is not resurrected by the REST baseline', async () => {
  const Q = QA(0xb4);
  const a = offer(Q, GOLD, true, { id: 'ka' }), b = offer(Q, GOLD, true, { id: 'kb' });
  REST = { [Q + '/' + GOLD]: [a, b], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  assert.equal(T.book().offers.length, 2);
  ws().handlers.onOfferRemoved({ maker_pubkey: b.maker_pubkey, offer_id: 'kb' });
  T.flushLiveBook();
  assert.deepEqual([...ids(T.book().offers)], ['ka'], 'removed offer gone despite resting in the REST baseline');
  T.stopLiveBook();
});

// ===================================================================================
// 5. Per-market snapshot authority: a re-delivered snapshot replaces ITS market's
//    rows in the live map (no ghosts from the previous snapshot), and only its own.
// ===================================================================================
test('a market snapshot replaces only its own market in the live map', async () => {
  const Q = QA(0xb5);
  REST = { [Q + '/' + GOLD]: [], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  const x = offer(Q, GOLD, true, { id: 'sx', covenant: true });
  const y = offer(Q, GOLD, true, { id: 'sy', covenant: true });
  const other = offer(GOLD, Q, true, { id: 'so', covenant: true });   // the OTHER orientation's market
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [x, y] });
  ws().handlers.onBook({ pair: { base_asset: GOLD, quote_asset: Q }, offers: [other] });
  T.flushLiveBook();
  assert.equal(T.book().offers.length, 2, 'both orientations delivered (asks side)');
  // Re-subscribe delivers a fresh snapshot for market Q/GOLD holding only x.
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [x] });
  T.flushLiveBook();
  const got = ids([...T.book().offers, ...T.book().otherOffers]);
  assert.ok(got.has('sx') && !got.has('sy'), 'the replaced market dropped its stale row');
  assert.ok(got.has('so'), 'the other market was untouched');
  T.stopLiveBook();
});

// ===================================================================================
// 6. A genuinely thin book renders honestly (no phantom depth from any source).
// ===================================================================================
test('a genuinely thin book stays a thin book', async () => {
  const Q = QA(0xb6);
  const only = offer(Q, GOLD, true, { id: 'only' });
  REST = { [Q + '/' + GOLD]: [only], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [only] });
  T.flushLiveBook();
  assert.equal(T.book().offers.length, 1);
  S.priceFlip = true;
  await T.requoteSame({ kind: 'same', pay: GOLD, receive: Q }, '');
  assert.equal(T.book().offers.length, 1, 'still one offer after the flip — honest, not collapsed, not inflated');
  T.stopLiveBook();
});

// ===================================================================================
// 7. ONE ladder on every rail: chain/chain, pure-LN (asset<->asset) and mixed
//    same-chain render byte-identical book content for the same pair.
// ===================================================================================
test('ladder content is identical across rail selections', async () => {
  const Q = QA(0xb7);
  const restAsk = offer(Q, GOLD, true, { id: 'ra' });
  const restBid = offer(Q, GOLD, false, { id: 'rb' });
  REST = { [Q + '/' + GOLD]: [restAsk, restBid], [GOLD + '/' + Q]: [] };
  // canonicalPair(GOLD='aa..', Q='b7..'): base = GOLD (lexicographically first).
  UNIFIED_FEED = { ok: true, quote: Q, asks: [], bids: [
    { side: 'bid', rail: 'pureln', assetAtoms: 50, btcSats: 5000, price: 100, id: 'pln1', maker: '03'.padEnd(66, 'c'), expires: null, raw: { lightning: { ln_direction: 2 } } },
  ] };
  await selectPair(GOLD, Q);
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [offer(Q, GOLD, true, { id: 'wc', covenant: true })] });
  T.flushLiveBook();
  const chainChain = { asks: ids(T.book().offers), bids: ids(T.book().otherOffers) };
  assert.ok(chainChain.asks.has('ra') && chainChain.asks.has('wc'), 'chain/chain shows REST + live rows');
  // The pure-LN row (a bid in the base/quote frame: gives the quote, wants GOLD) is on the
  // LIFTABLE side of a pay-GOLD/receive-quote composer — one book, rail-blind.
  assert.ok(chainChain.asks.has('pln1'), 'chain/chain shows the pure-LN family too');
  assert.ok(chainChain.bids.has('rb'), 'the opposite side renders as well');

  // Pure-LN rails (asset<->asset): same pair, same ladder.
  S.payRail = 'ln'; S.recvRail = 'ln';
  await T.requoteLn({ kind: 'ln', assetAsset: true, seqAsset: GOLD, quoteAsset: Q, payIsBtc: false, payRail: 'ln', recvRail: 'ln' }, '');
  assert.deepEqual({ asks: ids(T.book().offers), bids: ids(T.book().otherOffers) }, chainChain, 'ln/ln renders the same ladder');

  // Mixed same-chain rails: same pair, same ladder.
  S.payRail = 'chain'; S.recvRail = 'ln';
  await T.requoteMixed({ kind: 'mixed', mixedSame: true, seqAsset: GOLD, quoteAsset: Q, payIsBtc: false, xm: null, payRail: 'chain', recvRail: 'ln' }, '');
  assert.deepEqual({ asks: ids(T.book().offers), bids: ids(T.book().otherOffers) }, chainChain, 'mixed same-chain renders the same ladder');
  T.stopLiveBook();
});

// ===================================================================================
// 8. The union carries all three families and dedupes across sources by
//    maker:offer_id (REST copy vs unified raw copy of the same offer = ONE row).
// ===================================================================================
test('union of covenant + plain + LN families, deduped across sources', async () => {
  const Q = QA(0xb8);
  const plain = offer(Q, GOLD, true, { id: 'up' });
  REST = { [Q + '/' + GOLD]: [plain], [GOLD + '/' + Q]: [] };
  // The unified book carries the SAME plain offer (as its raw same-chain row) + a pure-LN ask.
  // canonicalPair base=GOLD, quote=Q; an ask in that frame gives GOLD.
  UNIFIED_FEED = { ok: true, quote: Q, asks: [
    { side: 'ask', rail: 'onchain', assetAtoms: 100, btcSats: 100, price: 1, id: 'up', maker: plain.maker_pubkey, expires: null, raw: { ...plain } },
    { side: 'ask', rail: 'pureln', assetAtoms: 70, btcSats: 7000, price: 100, id: 'upl', maker: '03'.padEnd(66, 'c'), expires: null, raw: { lightning: { ln_direction: 3 } } },
  ], bids: [] };
  await selectPair(GOLD, Q);
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [offer(Q, GOLD, true, { id: 'uc', covenant: true })] });
  T.flushLiveBook();
  const all = [...T.book().offers, ...T.book().otherOffers];
  const got = ids(all);
  assert.ok(got.has('up') && got.has('uc') && got.has('upl'), 'all three families present');
  assert.equal(all.filter(o => o.offer_id === 'up').length, 1, 'the duplicated plain offer renders once');
  const pln = all.find(o => o.offer_id === 'upl');
  assert.equal(pln._displayOnly, true, 'the LN-family row is display-tagged (not walk-executable)');
  T.stopLiveBook();
});

// ===================================================================================
// 9. MATCH HONESTY: a non-executable LN-family row is SHOWN but never silently
//    matched — a market take with only display-only depth refuses plainly, and a
//    display-only row at a better price never becomes the market quote.
// ===================================================================================
test('a market take never silently picks a non-executable row', async () => {
  const Q = QA(0xb9);
  BAL[GOLD] = '1000000'; BAL[Q] = '1000000';
  REST = { [Q + '/' + GOLD]: [], [GOLD + '/' + Q]: [] };
  // ONLY a pure-LN row rests (pay GOLD -> receive Q is a SELL of base GOLD; the matching
  // display row is a bid in the base/quote frame, i.e. liftable from this side).
  UNIFIED_FEED = { ok: true, quote: Q, asks: [], bids: [
    { side: 'bid', rail: 'pureln', assetAtoms: 100, btcSats: 100, price: 1, id: 'onlypln', maker: '03'.padEnd(66, 'c'), expires: null, raw: { lightning: { ln_direction: 2 } } },
  ] };
  await selectPair(GOLD, Q, { pay: '10', recv: '10' });
  assert.equal(T.book().offers.length, 1, 'the LN row IS shown (one book, rail-blind)');
  assert.equal(T.book().offers[0]._displayOnly, true);
  assert.equal(T.lastQuote(), null, 'no silent match against a row this take cannot settle');
  assert.match(REG.swErr.textContent, /Nothing is resting that crosses your price/, 'honest refusal names the truth');
  T.stopLiveBook();
});

test('the walk candidate order is best-price-first over the executable rows only', async () => {
  const Q = QA(0xba);
  BAL[GOLD] = '1000000'; BAL[Q] = '1000000';
  // Liftable side (gives Q, wants GOLD): a better-priced PLAIN interactive offer (non-covenant),
  // a worse-priced covenant, and a display-only pure-LN row priced best of all.
  const plainBest = offer(Q, GOLD, true, { id: 'w-plain', off: 120, want: 100 });    // 1.2 Q per GOLD
  const covWorse = offer(Q, GOLD, true, { id: 'w-cov', off: 100, want: 100, covenant: true });  // 1.0
  REST = { [Q + '/' + GOLD]: [plainBest, covWorse], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = { ok: true, quote: Q, asks: [], bids: [
    { side: 'bid', rail: 'pureln', assetAtoms: 100, btcSats: 200, price: 2, id: 'w-pln', maker: '03'.padEnd(66, 'c'), expires: null, raw: { lightning: { ln_direction: 2 } } },
  ] };
  await selectPair(GOLD, Q, { pay: '10', recv: '10' });
  const rows = T.renderSameUnion(GOLD, Q);
  // The ladder shows all three, best price first; the executable order puts the better-priced
  // PLAIN offer before the covenant (price beats family), and the display row is excluded.
  const execRows = rows.filter(o => !o._displayOnly);
  assert.deepEqual(execRows.map(o => o.offer_id), ['w-plain', 'w-cov'], 'better-priced non-covenant beats the worse covenant');
  assert.ok(ids(rows).has('w-pln'), 'the non-executable row is still shown');
  // The market take routes to the covenant walk (kind same/takeMkt) — never the display row.
  assert.ok(T.lastQuote() && T.lastQuote().kind === 'same' && T.lastQuote().takeMkt, 'market take matched against executable depth');
  T.stopLiveBook();
});

// ===================================================================================
// 10. The missing-snapshot re-subscribe: a market whose snapshot never arrived is
//     re-requested on the bounded snapshot check.
// ===================================================================================
test('a market with no snapshot is re-subscribed', async (t) => {
  const Q = QA(0xbb);
  REST = { [Q + '/' + GOLD]: [], [GOLD + '/' + Q]: [] };
  UNIFIED_FEED = null;
  await selectPair(GOLD, Q);
  // Only ONE market's snapshot arrives.
  ws().handlers.onBook({ pair: { base_asset: Q, quote_asset: GOLD }, offers: [] });
  T.flushLiveBook();
  await new Promise(r => setTimeout(r, 4300));   // the 4s snapshot check
  const re = ws().resubs.map(p => (p.base_asset || '') + '/' + (p.quote_asset || ''));
  assert.ok(re.includes(GOLD + '/' + Q), 'the missing market was re-requested');
  assert.ok(!re.includes(Q + '/' + GOLD), 'the delivered market was not');
  T.stopLiveBook();
});
