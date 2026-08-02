// F1 (asset picker) + F2 (hidden assets), headless (the tiny DOM shim, no browser),
// driving the REAL candidate construction + filtering (pickerCandidates/pickerMatches)
// and the real hidden-asset store — never a re-implementation. Owner rulings pinned:
//   1. DEFAULT (empty search): the picker shows ONLY assets with a positive balance in
//      this wallet (on-chain or Lightning) plus native BTC (the parent-chain first-class
//      asset, shown even at 0) — never the registry tail. Hidden assets are excluded.
//   2. TYPING searches the FULL registry by ticker/name: a registry-only asset with zero
//      balance is found and selectable; hidden assets are found too.
//   3. PASTING a 64-hex asset id yields a selectable, TRADEABLE row even when the id is
//      in no registry: fallback meta = id-prefix ticker at precision 8 (metaOf), and the
//      picked id flows through routing (books are keyed by hex) + survives validation.
//   4. Hiding (Balance tab) removes an asset from the default picker AND the balance
//      main list (partitionHidden), moves it to the hidden section, round-trips
//      persistence, and unhide restores it. BTC can never be hidden. Hiding is visual
//      decluttering only — the headline total logic never consults the hidden set.
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

// --- fixture assets ----------------------------------------------------------------
const GOLD  = 'aa'.repeat(32);   // held on-chain + in the registry
const SILVR = 'cc'.repeat(32);   // held on-chain + in the registry (the one we hide)
const USDX  = 'bb'.repeat(32);   // registry-only, zero balance (search must find it)
const UNKNOWN = 'dd'.repeat(32); // in NO registry: only reachable by pasting the id
const METAS = {
  BTC:     { ticker: 'BTC',   name: 'Bitcoin testnet4', precision: 8 },
  [GOLD]:  { ticker: 'GOLD',  name: 'Gold (troy ounce)', precision: 0 },
  [SILVR]: { ticker: 'SILVR', name: 'Silver', precision: 0 },
  [USDX]:  { ticker: 'USDX',  name: 'US Dollar X', precision: 8 },
};

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
  // The same placeholder the wallet's assetMeta produces for an id nobody can name.
  assetMeta: (h) => METAS[h] || { ticker: String(h).slice(0, 8) + '…', name: 'Asset', precision: 0 },
  fmtAtoms, parseAtoms,
  assetAmountOf: (el) => (el && el.value) || '',
  refValueStr: () => '',
  wollet: null,
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),
  registryAssets: () => [GOLD, SILVR, USDX],
  balObj: () => ({ [GOLD]: '5', [SILVR]: '7' }),
  btcBalance: 0,   // a fresh dual-chain wallet: BTC is at 0, and must still show
};

const swap = await import('./swap.js');
swap.initSwap({ ...C,
  xroute: { quote: async () => ({}), book: async () => ({ forward: [], reverse: [], unreachable: false }) },
  ln: { available: () => false, deployed: () => false, status: async () => ({ channels: [] }) } });
const T = swap.__test__;
const S = T.state;
T.setXMarkets([{ seq_asset: GOLD }]);   // a cross market exists, so BTC is startable

const hexes = (rows) => rows.map(r => r.hex);
function defaultRows(side){ const { list } = T.pickerCandidates(side); return T.pickerMatches(list, ''); }
function searchRows(side, q){ const { list } = T.pickerCandidates(side); return T.pickerMatches(list, q); }

// ===========================================================================
// 1) DEFAULT = held (on-chain or Lightning) + native BTC; the registry tail stays out.
// ===========================================================================
{
  S.payAsset = null; S.receiveAsset = null;
  const rows = defaultRows('pay');
  assert.ok(hexes(rows).includes(GOLD), 'a held asset shows by default');
  assert.ok(hexes(rows).includes(SILVR), 'every held asset shows by default');
  assert.ok(hexes(rows).includes('BTC'), 'native BTC shows by default even at 0 (parent-chain first-class)');
  assert.ok(!hexes(rows).includes(USDX), 'a registry-only zero-balance asset does NOT show by default');
  const btc = rows.find(r => r.hex === 'BTC');
  assert.equal(btc.enabled, true, 'BTC is selectable at 0');
  console.log('ok: default picker = held assets + native BTC, no registry tail');
}

// ===========================================================================
// 2) TYPING searches the FULL registry: a zero-balance registry asset is found by
//    ticker (and by name), shown with ticker + name, and selectable.
// ===========================================================================
{
  let rows = searchRows('pay', 'usd');
  assert.deepEqual(hexes(rows), [USDX], 'ticker search finds the registry-only asset');
  assert.equal(rows[0].enabled, true, 'and it is selectable at zero balance');
  assert.equal(rows[0].ticker, 'USDX');
  assert.equal(rows[0].name, 'US Dollar X', 'matches show ticker + name');
  rows = searchRows('pay', 'dollar');
  assert.ok(hexes(rows).includes(USDX), 'name search finds it too');
  console.log('ok: search reaches the full registry by ticker and name');
}

// ===========================================================================
// 3) PASTED 64-HEX ID: an id in NO registry becomes a selectable, tradeable row with
//    the fallback meta (id-prefix ticker, precision 8); a KNOWN id matches its real
//    row instead (no synthesis). The pick then flows through routing + validation.
// ===========================================================================
{
  const rows = searchRows('pay', UNKNOWN.toUpperCase());   // case-insensitive paste
  assert.equal(rows.length, 1, 'a pasted unknown id yields exactly one row');
  const r = rows[0];
  assert.equal(r.hex, UNKNOWN, 'normalized to the canonical lowercase id');
  assert.equal(r.pasted, true, 'marked pasted (registered on pick)');
  assert.equal(r.enabled, true, 'selectable');
  assert.equal(r.ticker, UNKNOWN.slice(0, 8) + '…', 'fallback ticker = id prefix');
  const m = T.metaOf(UNKNOWN);
  assert.equal(m.precision, 8, 'unknown id trades at the chain-native precision 8, never 0');
  // A pasted id the registry KNOWS resolves to its real row, not a synthesized one.
  const known = searchRows('pay', USDX);
  assert.deepEqual(hexes(known), [USDX], 'a known pasted id matches its registry row');
  assert.ok(!known[0].pasted, 'and is not re-synthesized');
  // The pick flows through: registration keeps it startable, routing quotes it by hex.
  T.notePasted(UNKNOWN);
  assert.ok(T.startableAssets().includes(UNKNOWN), 'a picked pasted id stays selectable');
  assert.equal(T.composerRoute(UNKNOWN, GOLD).kind, 'same', 'it routes on the same-chain book (keyed by hex)');
  assert.equal(T.composerRoute('BTC', UNKNOWN).kind, 'cross', 'and on the BTC cross book, without registry presence');
  S.payAsset = UNKNOWN; S.receiveAsset = GOLD;
  T.ensureDefaults();
  assert.equal(S.payAsset, UNKNOWN, 'composer validation keeps the pasted pick');
  S.payAsset = null; S.receiveAsset = null;
  console.log('ok: a pasted asset id is tradeable with fallback meta, and the pick sticks');
}

// ===========================================================================
// 4) HIDDEN ASSETS: hiding removes from the default picker + the balance main list,
//    lands in the hidden partition, stays findable by search or pasted id, and
//    round-trips persistence. Unhide restores everything. BTC can never be hidden.
// ===========================================================================
{
  T.setAssetHidden(SILVR, true);
  // Default picker: gone. Search: still found, by ticker AND by pasted id.
  assert.ok(!hexes(defaultRows('pay')).includes(SILVR), 'hidden asset leaves the default picker');
  assert.ok(hexes(defaultRows('pay')).includes(GOLD), 'other held assets stay');
  assert.deepEqual(hexes(searchRows('pay', 'silv')), [SILVR], 'hidden asset is FOUND by ticker search');
  assert.deepEqual(hexes(searchRows('pay', SILVR)), [SILVR], 'and by its pasted id');
  // Balance list partition (what renderBalance renders): main list vs hidden section.
  const totals = (h) => (h === SILVR ? 7n : 5n);
  let p = T.partitionHidden([GOLD, SILVR], totals);
  assert.deepEqual(p.visible, [GOLD], 'hidden asset leaves the balance main list');
  assert.deepEqual(p.hidden, [SILVR], 'and appears in the hidden section');
  // A hidden asset at ZERO total appears in neither (the list already elides zero rows).
  p = T.partitionHidden([GOLD, SILVR], () => 0n);
  assert.deepEqual(p.hidden, [], 'a zero-total hidden asset is not listed in the hidden section');
  // Persistence round-trip: the set is stored per wallet and re-read from storage.
  const key = [..._ls.keys()].find(k => k.startsWith('swk.hidden.'));
  assert.ok(key, 'hidden set persists under the per-wallet swk.hidden.<fingerprint> key');
  assert.deepEqual(JSON.parse(_ls.get(key)), [SILVR], 'the stored set holds the hidden id');
  assert.ok(T.hiddenAssets().has(SILVR), 'a fresh read from storage returns the same set');
  assert.equal(T.isAssetHidden(SILVR), true);
  // BTC is the parent chain: never hideable.
  T.setAssetHidden('BTC', true);
  assert.equal(T.isAssetHidden('BTC'), false, 'BTC cannot be hidden');
  assert.deepEqual(T.partitionHidden(['BTC'], () => 0n).visible, ['BTC'], 'and is never partitioned out');
  // Unhide restores the default picker and the main list.
  T.setAssetHidden(SILVR, false);
  assert.ok(hexes(defaultRows('pay')).includes(SILVR), 'unhide restores the default picker row');
  p = T.partitionHidden([GOLD, SILVR], totals);
  assert.deepEqual(p.visible, [GOLD, SILVR], 'unhide restores the balance main list');
  assert.deepEqual(p.hidden, []);
  assert.deepEqual(JSON.parse(_ls.get(key)), [], 'the persisted set is emptied');
  console.log('ok: hide/unhide round-trips storage, the picker default, and the balance partition');
}

// ===========================================================================
// 5) The pinned swap-sides row (the other side's asset) always shows, even hidden or
//    unheld — picking it must stay a one-tap pair flip whatever its visibility state.
// ===========================================================================
{
  T.setAssetHidden(SILVR, true);
  S.payAsset = GOLD; S.receiveAsset = SILVR;
  const rows = defaultRows('pay');   // the picker for the PAY side pins the RECEIVE asset
  const pin = rows.find(r => r.pin);
  assert.ok(pin && pin.hex === SILVR, 'the other side stays pinned in the default view even while hidden');
  T.setAssetHidden(SILVR, false);
  S.payAsset = null; S.receiveAsset = null;
  console.log('ok: the pinned tap-to-swap-sides row is visibility-proof');
}

console.log('\nALL PASS');
