// ---------------------------------------------------------------------------
// SeqDEX same-chain swap tab (Phase 6d-1).
//
// A self-contained module — like btc.js — that the main wallet wires up once
// via initSwap(ctx). It mirrors the Send/Stake panels: a quote step, a
// structured review modal (never blind-sign), then sign + settle.
//
// The taker SwapRequest is built by the lwk_wasm binding
// `Wollet.seqdexSwapRequest(...)` (the reason that binding exists — we don't
// hand-roll the PSET). The daemon's same-chain Trade API (seqdex.v1, served as
// REST `/v1/*` on one port) is reached via dexPost().
//
// Project UI rules honoured here:
//  • SEQ equal standing — SEQ/tSEQ is just another asset in markets/selectors;
//    no privileged "native" hero or hint (only `assetMeta` tickers are used).
//  • Any-asset fees — the fee-asset selector (reused populateFeeAssets logic),
//    passing fee_asset/fee_amount to propose.
//  • Reference currency — every amount carries an `≈ <ref>` hint.
//  • Anchor-aware finality — success copy says settlement is anchor-bounded and
//    can reorg only if Bitcoin does (never "instant/irreversible").
// ---------------------------------------------------------------------------

let C = null;          // the injected app context (see index.html initSwapTab)
let MARKETS = [];      // [{ market:{base_asset,quote_asset}, fee:{...} }]
let LAST_QUOTE = null; // the priced/previewed legs for the selected market+side+amount

const TRADE_TYPE = { BUY: 0, SELL: 1 };   // seqdex.v1 TradeType enum

// POST <DEX>/v1/... as JSON; returns parsed JSON (or throws a useful message).
async function dexPost(path, body){
  const r = await fetch(C.DEX + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) {
    // grpc-gateway errors come back as {code,message,details}
    const msg = (j && (j.message || j.error)) || j._raw || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j;
}

// The market maker's amounts are JS_STRING-typed uint64 over the gateway, so
// coerce to BigInt everywhere we do amount math.
const big = v => BigInt(v == null ? 0 : v);

// The grpc-gateway emits camelCase JSON on output but accepts either case on
// input. Read a field by its snake_case proto name OR its camelCase form so the
// tab is robust to the marshaler. e.g. pick(m, 'base_asset','baseAsset').
function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
// A market object normalized to snake_case the rest of the module expects.
function normMarket(m){
  const mk = pick(m, 'market') || m;
  return { base_asset: pick(mk, 'base_asset', 'baseAsset'),
           quote_asset: pick(mk, 'quote_asset', 'quoteAsset') };
}

export function initSwap(ctx){
  C = ctx;
  const { $ } = C;
  if ($('btnSwapQuote') && !$('btnSwapQuote')._wired){
    $('btnSwapQuote')._wired = true;
    $('btnSwapQuote').onclick = onQuote;
    $('btnSwapReview').onclick = onReviewSwap;
    $('swMarket').onchange = () => { resetQuote(); updateAmtLabel(); };
    $('swSide').onchange   = () => { resetQuote(); updateAmtLabel(); };
    $('swFeeAsset').onchange = updateSwapFeeHint;
    // Reference-currency hint under the amount, valued in the asset being entered
    // (which leg depends on the side; see amountAsset()).
    C.attachRefHint($('swAmount'), () => amountAsset());
  }
}

// The selected market + its parts.
function selMarket(){
  const sel = C.$('swMarket'); if (!sel || !MARKETS.length) return null;
  const m = MARKETS[sel.selectedIndex]; return m || MARKETS[0];
}
function selSide(){ return C.$('swSide').value === 'SELL' ? 'SELL' : 'BUY'; }

// The amount field is denominated in the BASE asset (the TDEX convention: the
// trade type BUY/SELL always refers to the fixed base asset, and amount/asset
// describe the base leg here for a clean UX).
function amountAsset(){
  const m = selMarket(); if (!m) return null;
  return m.market.base_asset;
}
function updateAmtLabel(){
  const m = selMarket(); if (!m){ C.$('swAmtLbl').textContent = 'Amount'; return; }
  const t = C.assetMeta(m.market.base_asset).ticker;
  C.$('swAmtLbl').textContent = 'Amount (' + t + ')';
}

function resetQuote(){
  LAST_QUOTE = null;
  C.$('swapQuote').classList.add('hide');
  C.$('btnSwapReview').classList.add('hide');
  C.$('swapErr').textContent = '';
  C.$('swapStatus').textContent = '';
}

// ---- markets ----
export async function renderSwap(){
  const { $, el } = C;
  if (!C.wollet) return;
  resetQuote();
  populateSwapFeeAssets();
  const status = $('swapStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading markets…';
  try {
    const resp = await dexPost('/v1/markets', {});
    // Normalize each market entry: {market:{base_asset,quote_asset}, fee} with
    // snake_case keys regardless of the gateway's camelCase output.
    MARKETS = (Array.isArray(resp.markets) ? resp.markets : []).map(m => ({
      market: normMarket(m),
      fee: pick(m, 'fee') || {},
    }));
    status.textContent = '';
    renderMarketList();
    populateMarketSelect();
    updateAmtLabel();
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'Could not load markets: ' + (e?.message ?? e);
    MARKETS = [];
    renderMarketList();
    populateMarketSelect();
  }
}

// Pretty "TICKER / TICKER" for a market, SEQ/tSEQ shown as just another asset.
function marketLabel(m){
  const b = C.assetMeta(m.market.base_asset).ticker;
  const q = C.assetMeta(m.market.quote_asset).ticker;
  return b + ' / ' + q;
}
function populateMarketSelect(){
  const { $, el } = C;
  const sel = $('swMarket'); const prev = sel.value;
  sel.innerHTML = '';
  if (!MARKETS.length){ const o = el('option'); o.value=''; o.textContent='No markets'; sel.appendChild(o); return; }
  MARKETS.forEach((m, idx) => {
    const o = el('option'); o.value = String(idx); o.textContent = marketLabel(m); sel.appendChild(o);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function renderMarketList(){
  const { $, el } = C;
  const list = $('swMarketList'); list.innerHTML = '';
  if (!MARKETS.length){ list.appendChild(el('div','muted','No markets available on this provider.')); return; }
  for (const m of MARKETS){
    const row = el('div','asset-row');
    row.appendChild(el('span','tk', marketLabel(m)));
    const mid = el('div','grow');
    // Maker fee: percentage (basis points) + fixed, per leg. No asset privileged.
    const f = m.fee || {};
    const pf = pick(f, 'percentage_fee', 'percentageFee') || {}, ff = pick(f, 'fixed_fee', 'fixedFee') || {};
    const bp = big(pick(pf, 'base_asset', 'baseAsset') || 0), qp = big(pick(pf, 'quote_asset', 'quoteAsset') || 0);
    const feeTxt = (bp || qp)
      ? `maker fee ${Number(bp)/100}% base · ${Number(qp)/100}% quote`
      : 'maker fee: fixed';
    mid.appendChild(el('div','sub', feeTxt));
    row.appendChild(mid);
    list.appendChild(row);
  }
}

// ---- fee asset selector (any-asset fees; reuses the wallet's pricing gate) ----
// Offer the daemon's native/base leg (the only asset the node prices for the
// network-fee leg today) plus any owned, node-priced asset — exactly like the
// Send tab's populateFeeAssets(), so no asset is privileged here either.
function populateSwapFeeAssets(){
  const { $, el } = C;
  const sel = $('swFeeAsset'); if (!sel) return;
  const prev = sel.value; sel.innerHTML = '';
  const add = (val,label) => { const o = el('option'); o.value = val; o.textContent = label; sel.appendChild(o); };
  add(C.POLICY_HEX, C.assetMeta(C.POLICY_HEX).ticker);   // tSEQ — default-accepted, but shown as a normal ticker
  const b = C.balObj();
  for (const h of Object.keys(b)){
    if (h === C.POLICY_HEX) continue;
    if (!(C.feeRates[h] && C.feeRates[h].rate > 0)) continue;   // gate unpriced assets out
    add(h, C.assetMeta(h).ticker);
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  updateSwapFeeHint();
}
function updateSwapFeeHint(){
  const { $ } = C;
  const sel = $('swFeeAsset'), hint = $('swFeeAssetHint'); if (!sel || !hint) return;
  const h = sel.value;
  if (!h || h === C.POLICY_HEX){ hint.textContent = ''; return; }
  const t = C.assetMeta(h).ticker;
  const priced = !!(C.feeRates[h] && C.feeRates[h].rate);
  hint.textContent = priced
    ? `Network-fee leg settled in ${t} at this node's published rate.`
    : `No published rate for ${t}; the fee estimate may be off.`;
}

// ---- quote (price + preview) ----
async function onQuote(){
  const { $ } = C;
  C.$('swapErr').textContent = '';
  const m = selMarket();
  if (!m){ C.$('swapErr').textContent = 'select a market'; return; }
  const baseHex = m.market.base_asset;
  const side = selSide();
  let amtAtoms;
  try {
    const amtStr = ($('swAmount').value || '').trim();
    amtAtoms = C.parseAtoms(amtStr, C.assetMeta(baseHex).precision || 0);
    if (amtAtoms <= 0n) throw new Error('enter an amount greater than zero');
  } catch (e){ C.$('swapErr').textContent = e?.message ?? String(e); return; }

  const status = $('swapStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Quoting…';
  try {
    const feeAsset = $('swFeeAsset').value || C.POLICY_HEX;
    // PreviewTrade: amount/asset describe the BASE leg; the daemon returns the
    // oriented send/receive legs + the fee leg.
    const prev = await dexPost('/v1/trade/preview', {
      market: { base_asset: m.market.base_asset, quote_asset: m.market.quote_asset },
      type: TRADE_TYPE[side],
      amount: amtAtoms.toString(),
      asset: baseHex,
      fee_asset: feeAsset,
    });
    const p = (prev.previews && prev.previews[0]) || null;
    if (!p) throw new Error('no preview returned for this market/amount');
    // Orient the legs from the previewed counter-leg + the side.
    const legs = orientLegs(m, side, amtAtoms, p);
    const price = pick(p, 'price') || null;
    LAST_QUOTE = { market: m.market, side, ...legs,
      feeAsset: pick(p, 'fee_asset', 'feeAsset') || feeAsset,
      feeAmount: big(pick(p, 'fee_amount', 'feeAmount') || 0),
      price: price ? { base_price: pick(price,'base_price','basePrice'), quote_price: pick(price,'quote_price','quotePrice') } : null };
    showQuote();
    status.textContent = '';
    $('btnSwapReview').classList.remove('hide');
  } catch (e){
    status.textContent = '';
    C.$('swapErr').textContent = 'Quote failed: ' + (e?.message ?? e);
  }
}

// Derive (assetP/amountP we SEND) and (assetR/amountR we RECEIVE) for this side.
// BUY base: we receive base, send quote.   SELL base: we send base, receive quote.
// The previewed `amount`/`asset` is the counter leg (fees excluded); we use it
// directly and fold in the fee on the leg the daemon charges.
function orientLegs(m, side, baseAtoms, p){
  const base = m.market.base_asset, quote = m.market.quote_asset;
  const counterAmt = big(pick(p, 'amount') || 0);          // previewed counter-leg amount (quote), fees excluded
  const counterAsset = pick(p, 'asset') || quote;
  if (side === 'BUY'){
    // receive base (the amount we typed), send quote (the previewed counter leg)
    return { assetP: counterAsset, amountP: counterAmt, assetR: base, amountR: baseAtoms };
  }
  // SELL: send base (typed), receive quote (previewed counter leg)
  return { assetP: base, amountP: baseAtoms, assetR: counterAsset, amountR: counterAmt };
}

function amtRow(hex, atoms){
  const m = C.assetMeta(hex);
  return C.fmtAtoms(atoms, m.precision) + ' ' + m.ticker;
}
function showQuote(){
  const { $ } = C; const q = LAST_QUOTE;
  $('swapQuote').classList.remove('hide');
  $('swQSend').textContent = amtRow(q.assetP, q.amountP);
  $('swQSendRef').textContent = C.refValueStr(q.assetP, q.amountP) || '';
  $('swQRecv').textContent = amtRow(q.assetR, q.amountR);
  $('swQRecvRef').textContent = C.refValueStr(q.assetR, q.amountR) || '';
  $('swQFee').textContent = amtRow(q.feeAsset, q.feeAmount);
  // Price, shown as the market spot price between the two assets.
  if (q.price && (q.price.base_price || q.price.quote_price)){
    const bt = C.assetMeta(q.market.base_asset).ticker, qt = C.assetMeta(q.market.quote_asset).ticker;
    $('swQPrice').textContent = `${q.price.base_price} ${qt}/${bt}`;
  } else $('swQPrice').textContent = '—';
}

// ---- review + propose + sign + complete ----
async function onReviewSwap(){
  const { $ } = C;
  C.$('swapErr').textContent = '';
  const q = LAST_QUOTE;
  if (!q){ C.$('swapErr').textContent = 'get a quote first'; return; }

  // Structured review rows — reconstructed from the quote (never wollet.psetDetails,
  // which throws on Sequentia explicit outputs). Never blind-sign.
  const sm = C.assetMeta(q.assetP), rm = C.assetMeta(q.assetR), fm = C.assetMeta(q.feeAsset);
  const kv = [
    ['Network', 'Sequentia (testnet) atomic swap; not parent-chain BTC'],
    ['Market', marketLabel({ market: q.market })],
    ['You send', amtRow(q.assetP, q.amountP) + ((C.refValueStr(q.assetP,q.amountP)) ? ('  ('+C.refValueStr(q.assetP,q.amountP)+')') : '')],
    ['You receive', amtRow(q.assetR, q.amountR) + ((C.refValueStr(q.assetR,q.amountR)) ? ('  ('+C.refValueStr(q.assetR,q.amountR)+')') : '')],
    ['Network fee', amtRow(q.feeAsset, q.feeAmount)],
    ['Fee paid in', fm.ticker],
    ['Settlement', 'Atomic — settles in full or not at all.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Confirm SeqDEX swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Proposing…';
    try {
      const txid = await proposeSignComplete(q, st);
      modal.remove();
      // Anchor-aware finality copy: settled, but anchor-bounded — never "instant".
      C.toast(`Swap settled: <a href="/tx/${txid}" target="_blank" rel="noopener">${String(txid).slice(0,18)}…</a> — anchor-bounded; can reorg only if Bitcoin does.`);
      resetQuote();
      await C.sync();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Build (lwk binding) -> propose -> sign (add_details + strip bip32) -> complete.
async function proposeSignComplete(q, st){
  const { wasm } = C;
  // (3) Build the taker SwapRequest with the lwk_wasm binding. The taker's own
  // confidential receive address takes asset_r + any asset_p change.
  const receiveAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const sreq = C.wollet.seqdexSwapRequest(
    new wasm.AssetId(q.assetP), q.amountP,
    new wasm.AssetId(q.assetR), q.amountR,
    receiveAddr,
    new wasm.AssetId(q.feeAsset), q.feeAmount,
  );

  // (4) Propose. The fee_asset/fee_amount live on the request envelope (the
  // SwapRequest message itself doesn't carry them) — the daemon validates them.
  st.innerHTML = '<span class="spin"></span>Proposing…';
  const propose = await dexPost('/v1/trade/propose', {
    market: { base_asset: q.market.base_asset, quote_asset: q.market.quote_asset },
    type: TRADE_TYPE[q.side],
    swap_request: sreq.toJson(),
    fee_amount: q.feeAmount.toString(),
    fee_asset: q.feeAsset,
  });
  const fail = pick(propose, 'swap_fail', 'swapFail');
  if (fail){
    throw new Error('Provider rejected the swap: ' + (pick(fail,'failure_message','failureMessage') || 'unknown reason'));
  }
  const accept = pick(propose, 'swap_accept', 'swapAccept');
  const acceptTx = accept && pick(accept, 'transaction');
  if (!acceptTx) throw new Error('no SwapAccept returned');
  const acceptId = pick(accept, 'id');

  // (5) Sign. The SwapAccept PSET is bare (no bip32 derivation), so Signer.sign
  // alone signs nothing — re-attach the taker input's keypath via add_details
  // first, sign, then strip the bip32/global-xpub fields back out (the daemon's
  // go-elements parser rejects them; the partial signature is preserved).
  st.innerHTML = '<span class="spin"></span>Signing…';
  const pset = new wasm.Pset(acceptTx);
  pset.addDetails(C.wollet);
  const signed = C.signer.sign(pset);     // returns a (new) Pset
  const strippedB64 = stripBip32(signed.toString());

  // (6) Complete. CompleteTrade is optional per the proto and can be flaky on
  // this daemon build (ocean fee-account churn) — if it fails, self-broadcast
  // the finalized swap tx ourselves (we hold a fully-signed PSET).
  st.innerHTML = '<span class="spin"></span>Completing…';
  try {
    const done = await dexPost('/v1/trade/complete', {
      swap_complete: { id: randId(), accept_id: acceptId, transaction: strippedB64 },
    });
    const cfail = pick(done, 'swap_fail', 'swapFail');
    if (cfail) throw new Error(pick(cfail,'failure_message','failureMessage') || 'CompleteTrade failed');
    const txid = pick(done, 'txid');
    if (txid) return txid;
    throw new Error('CompleteTrade returned no txid');
  } catch (e){
    // Self-broadcast fallback: finalize the signed PSET and push it via the
    // wallet's own esplora client (the swap is atomic regardless of who relays).
    st.innerHTML = '<span class="spin"></span>Self-broadcasting…';
    const finalPset = new wasm.Pset(strippedB64);
    const finalized = C.wollet.finalize(finalPset);
    const txid = await C.client.broadcast(finalized);
    return txid.toString ? txid.toString() : String(txid);
  }
}

// 16-hex swap-complete id (matches the daemon's randstr.Hex(8)).
function randId(){
  const a = new Uint8Array(8); (crypto || window.crypto).getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,'0')).join('');
}

// ---------------------------------------------------------------------------
// PSET bip32 / global-xpub stripper.
//
// lwk's add_details injects PSBT_IN_BIP32_DERIVATION (input key 0x06) and may
// add PSBT_GLOBAL_XPUB (global key 0x01); go-elements (the daemon's psetv2
// parser) rejects those, so we drop them before CompleteTrade — exactly as the
// Rust taker does (global.xpub.clear(); input.bip32_derivation.clear();
// output.bip32_derivation.clear()). The partial signature (input key 0x02,
// PSBT_IN_PARTIAL_SIG) is NOT touched. Verified byte-exact against the daemon-
// accepted PSET in testing.
// ---------------------------------------------------------------------------
function b64ToBytes(b64){
  const bin = atob(b64.trim()); const a = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64(a){
  let s=''; for (let i=0;i<a.length;i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function stripBip32(b64){
  const b = b64ToBytes(b64);
  const magic = [0x70,0x73,0x65,0x74,0xff];                 // "pset\xff"
  for (let i=0;i<5;i++) if (b[i]!==magic[i]) throw new Error('not a PSET');
  let i = 5;
  const out = [0x70,0x73,0x65,0x74,0xff];
  const rdVarint = () => {
    const x = b[i++];
    if (x < 0xfd) return x;
    if (x === 0xfd){ const v = b[i] | (b[i+1]<<8); i+=2; return v; }
    if (x === 0xfe){ const v = (b[i] | (b[i+1]<<8) | (b[i+2]<<16) | (b[i+3]<<24))>>>0; i+=4; return v; }
    // 0xff: 8-byte — counts never exceed 2^53 here, read as Number
    let v = 0; for (let k=0;k<8;k++) v += b[i+k] * Math.pow(2, 8*k); i+=8; return v;
  };
  const emitVarint = (v) => {
    if (v < 0xfd) out.push(v);
    else if (v <= 0xffff){ out.push(0xfd, v & 0xff, (v>>8)&0xff); }
    else if (v <= 0xffffffff){ out.push(0xfe, v&0xff, (v>>8)&0xff, (v>>16)&0xff, (v>>>24)&0xff); }
    else { out.push(0xff); for (let k=0;k<8;k++){ out.push(Math.floor(v/Math.pow(2,8*k))&0xff); } }
  };
  const copyMap = (dropTypes) => {
    while (true){
      const klen = rdVarint();
      if (klen === 0){ out.push(0x00); break; }
      const keyStart = i; const keyType = b[i];
      i += klen;
      const vlen = rdVarint();
      const valStart = i; i += vlen;
      if (dropTypes.has(keyType)) continue;                // drop this key/value pair
      emitVarint(klen); for (let k=keyStart;k<keyStart+klen;k++) out.push(b[k]);
      emitVarint(vlen); for (let k=valStart;k<valStart+vlen;k++) out.push(b[k]);
    }
  };
  // Peek the global map (without dropping) to read input/output counts.
  let inCount = 0, outCount = 0;
  { let j = 5;
    const pv = () => { const x = b[j++];
      if (x<0xfd) return x;
      if (x===0xfd){ const v=b[j]|(b[j+1]<<8); j+=2; return v; }
      if (x===0xfe){ const v=(b[j]|(b[j+1]<<8)|(b[j+2]<<16)|(b[j+3]<<24))>>>0; j+=4; return v; }
      let v=0; for (let k=0;k<8;k++) v+=b[j+k]*Math.pow(2,8*k); j+=8; return v; };
    while (true){
      const kl = pv(); if (kl===0) break;
      const kt = b[j]; j += kl;
      const vl = pv(); const vs = j; j += vl;
      if (kt === 0x04){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); inCount = v; }
      if (kt === 0x05){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); outCount = v; }
    }
  }
  copyMap(new Set([0x01]));                  // global: drop PSBT_GLOBAL_XPUB
  for (let n=0;n<inCount;n++) copyMap(new Set([0x06]));   // input:  drop PSBT_IN_BIP32_DERIVATION
  for (let n=0;n<outCount;n++) copyMap(new Set([0x02]));  // output: drop PSBT_OUT_BIP32_DERIVATION
  return bytesToB64(Uint8Array.from(out));
}

// Test-only exports: let a headless harness drive the REAL swap pipeline
// (build -> propose -> sign+strip -> complete) and the PSET stripper without a
// browser/DOM. Unused by the browser app (which only imports initSwap/renderSwap).
export const __test__ = { proposeSignComplete, stripBip32, dexPost,
  setMarkets: (m) => { MARKETS = m; }, orientLegs, pick };
