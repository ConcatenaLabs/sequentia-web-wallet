// The network fee of a payment, set the way Sequentia Qt's fee section sets it
// (src/qt/sendcoinsdialog.cpp): the asset that pays it, then either a recommended rate for a
// confirmation target or a custom one, shown as the total for this transaction and the rate per
// 100 bytes, each in the fee asset and in the reference currency. All four custom fields can be
// typed; the other three follow.
//
// No unit of one asset is named for another: a rate is "per 100 bytes" in the fee asset's own
// whole units, never "sat/vB" (a satoshi is the eighth decimal of BTC, not of USDX), never the
// reference unit the node prices fees in.
//
// Internally every rate is the fee asset's atoms per 1000 vbytes, the number SWK and the node read.
// The page supplies everything about assets, prices and the network through `deps`, so the same
// panel serves Send and the rescue dialogs (replace, bump, speed up).

// --- pure arithmetic, exported for the tests ---

// The total a rate comes to for `vsize` vbytes, in atoms, rounded up: a fee rounded down can land
// under the rate it was meant to pay.
export function totalFromPerKvb(perKvb, vsize) {
  if (!(perKvb > 0) || !(vsize > 0)) return 0;
  return Math.ceil(perKvb * vsize / 1000);
}
// The rate a total pays for `vsize` vbytes, atoms per 1000 vbytes.
export function perKvbFromTotal(total, vsize) {
  if (!(total > 0) || !(vsize > 0)) return 0;
  return total * 1000 / vsize;
}
// Whole units typed (a decimal string or number) as atoms of an asset with `precision` decimals.
export function unitsToAtoms(units, precision) {
  const u = Number(units);
  return u > 0 ? u * Math.pow(10, precision) : 0;
}
// Atoms as whole units, written out in full at the asset's precision (no "1e-8"), atoms rounded up.
export function atomsToUnits(atoms, precision) {
  const a = Math.ceil(Number(atoms) || 0);
  if (!(a > 0)) return '0';
  const s = (a / Math.pow(10, precision)).toFixed(precision);
  return precision > 0 ? s.replace(/\.?0+$/, '') : s;
}
// A reference-currency value written out with enough decimals to be read, never in "1.2e-7".
export function fmtRefNum(v) {
  const x = Number(v);
  if (!(x > 0)) return '0';
  const d = Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(x))));
  return x.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
// Atoms of an asset worth `ref` in the reference currency, when one whole unit is worth `price`.
export function refToAtoms(ref, price, precision) {
  const r = Number(ref), p = Number(price);
  return r > 0 && p > 0 ? r / p * Math.pow(10, precision) : 0;
}
export function atomsToRef(atoms, price, precision) {
  const p = Number(price);
  return p > 0 ? Number(atoms) / Math.pow(10, precision) * p : null;
}
// Bitcoin's recommended rate (sat per vbyte) for a target of `blocks`, from an Esplora
// /fee-estimates answer ({ "<blocks>": satPerVb }): the estimate for the nearest target at least as
// patient, which never promises more speed than the network estimated. Null when there is none.
export function btcEstimateFor(estimates, blocks) {
  if (!estimates || typeof estimates !== 'object') return null;
  const keys = Object.keys(estimates).map(Number).filter(k => k > 0 && Number(estimates[k]) > 0).sort((a, b) => a - b);
  const k = keys.find(k => k >= blocks);
  return k == null ? null : Number(estimates[k]);
}

// The rate is shown per this many bytes: a payment is a few hundred bytes, so the rate reads close to
// what one costs. Internally it stays atoms per 1000 vbytes, as SWK and the node take it; only what
// is printed and typed is scaled.
export const RATE_BYTES = 100;
const perLabel = 'Per ' + RATE_BYTES + ' bytes';
const toShown = (perKvb) => perKvb * RATE_BYTES / 1000;
const fromShown = (x) => x * 1000 / RATE_BYTES;

// A rate in whole units per RATE_BYTES, with one decimal more than the asset has: a whole atom per
// 1000 bytes is a tenth of one per 100, and an indivisible asset at its floor would otherwise read
// "0". Rounded up at that decimal, like every fee shown here.
export function rateUnits(perKvb, precision) {
  const tenths = Math.ceil(toShown(Number(perKvb) || 0) * 10 - 1e-9);
  if (!(tenths > 0)) return '0';
  return (tenths / 10 / Math.pow(10, precision)).toFixed(precision + 1).replace(/\.?0+$/, '');
}
// A rate as a sentence fragment: "0.000001 USDX per 100 bytes (≈ 0.000001 USD)".
export function rateText(perKvb, { ticker, precision }, price, ccy) {
  return rateUnits(perKvb, precision) + ' ' + ticker + ' ' + perLabel.toLowerCase()
    + (price > 0 ? ' (≈ ' + fmtRefNum(atomsToRef(toShown(perKvb), price, precision)) + ' ' + ccy + ')' : '');
}

// The confirmation targets offered, in blocks.
export const TARGETS = [1, 2, 3, 6, 12];

// --- the panel ---
//
// deps:
//   el(tag, cls, text)              the page's element helper
//   meta(hex)                       { ticker, precision }
//   price(hex)                      the reference value of one whole unit, or null
//   refCcy()                        the reference currency's code, e.g. 'USD'
//   select                          an existing <select> of fee assets (Send), or omitted:
//   assets()                        [{ hex, ticker }] to fill the panel's own select
//   preferHex                       which of them to start on
//   fixedHex()                      optional: an asset that pays the fee whatever the select says
//                                   (a Bitcoin payment pays in BTC); the select is hidden meanwhile
//   hint(hex, box)                  optional: writes what is known about the asset into `box`
//   recommend(hex, blocks)          Promise<{ perKvb, why }>: the recommended rate and, when it is
//                                   not an estimate, the reason in a few words
//   network(hex)                    Promise<{ text, floorPerKvb }|null>: what the next block looks like
//   vsize(hex)                      Promise<number|null>: the transaction's size, null until known
//   minimum(hex)                    optional: the lowest rate the network would take (atoms/kvB);
//                                   under it the panel says so and refuses (a replacement)
//   minimumWhy                      the sentence for that refusal
//   previous                        optional { hex, atoms, vsize }: what the transaction it replaces
//                                   or speeds up already pays, shown above the choice
//   note(hex, perKvb)               optional Promise<{ level, text, block }|null>: what the rate clears
//   minutesPerBlock                 1 on Sequentia, 10 on Bitcoin, or a function of the fee asset
//   sizeHint                        the sentence shown while the size is unknown
//   open                            start with the details shown
//   onChange()                      called after any change
export function mountFeePanel(box, deps) {
  const { el } = deps;
  const st = { mode: 'auto', blocks: 1, perKvb: 0, autoPerKvb: 0, why: '', vsize: null, seq: 0, last: null };

  const summary = el('div', 'fee-summary');
  const sumText = el('span', 'sub');
  const toggle = el('button', 'ghost fee-adv-btn', 'Advanced');
  toggle.type = 'button';
  summary.appendChild(sumText); summary.appendChild(toggle);
  box.appendChild(summary);

  const adv = el('div', 'fee-adv'); box.appendChild(adv);
  const setOpen = (on) => { adv.classList.toggle('hide', !on); toggle.textContent = on ? 'Hide' : 'Advanced'; toggle.setAttribute('aria-expanded', on ? 'true' : 'false'); };
  toggle.onclick = () => setOpen(adv.classList.contains('hide'));
  setOpen(!!deps.open);

  // Pay the fee in
  const assetRow = el('div', 'fee-line');
  assetRow.appendChild(el('span', 'fee-k', 'Pay the fee in'));
  const sel = deps.select || el('select');
  if (!deps.select) {
    for (const a of deps.assets()) { const o = el('option'); o.value = a.hex; o.textContent = a.ticker; sel.appendChild(o); }
    if (deps.preferHex && [...sel.options].some(o => o.value === deps.preferHex)) sel.value = deps.preferHex;
  }
  assetRow.appendChild(sel); adv.appendChild(assetRow);
  const hintBox = el('div', 'sub fee-hint'); adv.appendChild(hintBox);

  // What the transaction it replaces already pays.
  const prevBox = el('div', 'sub fee-prev'); adv.appendChild(prevBox);

  // Recommended
  const radio = (label) => {
    const l = el('label', 'fee-radio'); const r = el('input'); r.type = 'radio'; r.name = 'feemode' + Math.random().toString(36).slice(2, 8);
    l.appendChild(r); l.appendChild(el('span', null, label)); return { l, r };
  };
  const rec = radio('Recommended'), cus = radio('Custom');
  cus.r.name = rec.r.name;
  adv.appendChild(rec.l);
  const recBody = el('div', 'fee-indent');
  const tRow = el('div', 'fee-line'); tRow.appendChild(el('span', 'fee-k', 'Confirmation time target'));
  const tSel = el('select');
  for (const n of TARGETS) { const o = el('option'); o.value = String(n); tSel.appendChild(o); }
  // Minutes per block depend on the chain that pays: Sequentia's minute, Bitcoin's ten.
  const labelTargets = () => {
    const mpb = typeof deps.minutesPerBlock === 'function' ? deps.minutesPerBlock(hex()) : (deps.minutesPerBlock || 1);
    for (const o of tSel.options) {
      const n = Number(o.value), min = n * mpb;
      o.textContent = (min < 60 ? min + ' minute' + (min === 1 ? '' : 's') : (min / 60) + ' hour' + (min === 60 ? '' : 's')) + ' (' + n + ' block' + (n === 1 ? '' : 's') + ')';
    }
  };
  tRow.appendChild(tSel); recBody.appendChild(tRow);
  const whyBox = el('div', 'sub'); recBody.appendChild(whyBox);
  adv.appendChild(recBody);
  adv.appendChild(cus.l);

  // The table: the total and the rate, in the asset and in the reference currency.
  const table = el('div', 'fee-table');
  const head = (t) => { const h = el('div', 'fee-th', t); table.appendChild(h); return h; };
  head(''); const thAsset = head(''); const thRef = head('');
  const cell = () => { const i = el('input', 'mono'); i.inputMode = 'decimal'; i.autocomplete = 'off'; table.appendChild(i); return i; };
  table.appendChild(el('div', 'fee-rk', 'Total for this transaction'));
  const totA = cell(), totR = cell();
  table.appendChild(el('div', 'fee-rk', perLabel));
  const perA = cell(), perR = cell();
  adv.appendChild(table);
  const sizeBox = el('div', 'sub'); adv.appendChild(sizeBox);
  const netBox = el('div', 'sub fee-net'); adv.appendChild(netBox);
  const noteBox = el('div', 'sub'); adv.appendChild(noteBox);

  const hex = () => (deps.fixedHex && deps.fixedHex()) || sel.value;
  const m = () => deps.meta(hex()) || { ticker: '', precision: 8 };

  // Paint the four fields from st.perKvb, skipping the one being typed in.
  const paint = (skip) => {
    const { ticker, precision } = m();
    const price = deps.price(hex()), ccy = deps.refCcy();
    assetRow.style.display = deps.fixedHex && deps.fixedHex() ? 'none' : '';
    labelTargets();
    thAsset.textContent = ticker; thRef.textContent = price > 0 ? ccy : '';
    perR.disabled = totR.disabled = !(price > 0);
    const per = st.perKvb, tot = totalFromPerKvb(per, st.vsize);
    if (skip !== perA) perA.value = per > 0 ? rateUnits(per, precision) : '';
    if (skip !== perR) perR.value = per > 0 && price > 0 ? fmtRefNum(atomsToRef(toShown(per), price, precision)) : '';
    if (skip !== totA) totA.value = st.vsize ? atomsToUnits(tot, precision) : '';
    if (skip !== totR) totR.value = st.vsize && price > 0 ? fmtRefNum(atomsToRef(tot, price, precision)) : '';
    for (const i of [totA, totR]) { i.placeholder = st.vsize ? '' : '—'; }
    sizeBox.textContent = st.vsize ? 'About ' + Math.round(st.vsize) + ' bytes.' : (deps.sizeHint || '');
    for (const i of [perA, perR, totA, totR]) i.classList.toggle('fee-ro', st.mode !== 'custom');
    // The one line shown with the details folded away.
    const totTxt = st.vsize && per > 0 ? atomsToUnits(tot, precision) + ' ' + ticker
      + (price > 0 ? ' (≈ ' + fmtRefNum(atomsToRef(tot, price, precision)) + ' ' + ccy + ')' : '') : '';
    const rateTxt = per > 0 ? rateUnits(per, precision) + ' ' + ticker + ' ' + perLabel.toLowerCase() : '';
    // Folded, the line says what the fee comes to and how soon, never a rate per byte: until the
    // transaction's size is known it says the total is still to come (the rate is in the details).
    sumText.textContent = 'Network fee: ' + (totTxt || (rateTxt ? 'set once the amount is entered' : '…')) + ' · '
      + (st.mode === 'custom' ? 'custom' : 'confirms in about ' + tSel.options[tSel.selectedIndex].textContent.replace(/ \(.*\)$/, ''));
    prevBox.textContent = '';
    if (deps.previous) {
      const p = deps.previous, pm = deps.meta(p.hex) || { ticker: '', precision: 8 }, pp = deps.price(p.hex);
      const pPer = perKvbFromTotal(p.atoms, p.vsize);
      prevBox.textContent = 'It pays now ' + atomsToUnits(p.atoms, pm.precision) + ' ' + pm.ticker
        + (pp > 0 ? ' (≈ ' + fmtRefNum(atomsToRef(p.atoms, pp, pm.precision)) + ' ' + ccy + ')' : '')
        + ', ' + rateText(pPer, pm, pp, ccy) + ', for about ' + Math.round(p.vsize) + ' bytes.';
    }
  };

  const verdict = async () => {
    const my = ++st.seq;
    let n = null;
    const min = deps.minimum ? deps.minimum(hex()) : 0;
    if (min > 0 && st.perKvb < min) {
      const { ticker, precision } = m(), price = deps.price(hex());
      n = { level: 'no', block: true, text: (deps.minimumWhy || 'The network takes nothing below') + ' ' + rateText(min, { ticker, precision }, price, deps.refCcy()) + '.' };
    } else if (deps.note) { try { n = await deps.note(hex(), st.perKvb); } catch {} }
    if (my !== st.seq) return;
    st.last = n;
    noteBox.className = !n ? 'sub' : n.level === 'no' ? 'status err' : n.level === 'warn' ? 'warn' : 'sub';
    noteBox.textContent = n ? n.text : '';
  };

  const changed = () => { paint(); verdict(); deps.onChange && deps.onChange(); };

  const setMode = (mode) => {
    st.mode = mode; rec.r.checked = mode === 'auto'; cus.r.checked = mode === 'custom';
    recBody.classList.toggle('fee-dim', mode !== 'auto');
    if (mode === 'auto') st.perKvb = st.autoPerKvb;
    changed();
  };
  rec.r.onchange = () => setMode('auto');
  cus.r.onchange = () => setMode('custom');

  const recompute = async () => {
    const h = hex(); if (!h) { sumText.textContent = 'Network fee: no asset to pay it in'; return; }
    let r = null; try { r = await deps.recommend(h, Number(tSel.value)); } catch {}
    if (h !== hex()) return;
    st.autoPerKvb = r && r.perKvb > 0 ? r.perKvb : 0; st.why = (r && r.why) || '';
    whyBox.textContent = st.why ? '(' + st.why + ')' : '';
    if (st.mode === 'auto') st.perKvb = st.autoPerKvb;
    try { const n = await deps.network(h); if (h === hex()) netBox.textContent = n && n.text ? n.text : ''; } catch {}
    changed();
  };
  const resize = async () => {
    const h = hex();
    let v = null; try { v = await deps.vsize(h); } catch {}
    if (h !== hex()) return;
    st.vsize = v > 0 ? v : null;
    changed();
  };

  // Typing any of the four sets the rate and switches to Custom.
  const typed = (input, toPerKvb) => {
    input.addEventListener('input', () => {
      if (st.mode !== 'custom') { st.mode = 'custom'; rec.r.checked = false; cus.r.checked = true; recBody.classList.add('fee-dim'); }
      const v = (input.value || '').trim();
      st.perKvb = /^\d*\.?\d+$|^\d+\.$/.test(v) ? Math.max(0, toPerKvb(parseFloat(v))) : 0;
      paint(input); verdict(); deps.onChange && deps.onChange();
    });
    input.addEventListener('blur', () => paint());
  };
  typed(perA, (x) => fromShown(unitsToAtoms(x, m().precision)));
  typed(perR, (x) => fromShown(refToAtoms(x, deps.price(hex()), m().precision)));
  typed(totA, (x) => st.vsize ? perKvbFromTotal(unitsToAtoms(x, m().precision), st.vsize) : 0);
  typed(totR, (x) => st.vsize ? perKvbFromTotal(refToAtoms(x, deps.price(hex()), m().precision), st.vsize) : 0);

  tSel.onchange = () => recompute();
  sel.addEventListener('change', () => {
    // A custom rate typed for one asset means nothing in another: back to the recommendation.
    if (st.mode === 'custom') { st.mode = 'auto'; rec.r.checked = true; cus.r.checked = false; recBody.classList.remove('fee-dim'); }
    if (deps.hint) deps.hint(hex(), hintBox);
    recompute(); resize();
  });

  rec.r.checked = true;
  if (deps.hint) deps.hint(hex(), hintBox);
  recompute(); resize();

  return {
    el: box,
    get hex() { return hex(); },
    // atoms of the fee asset per 1000 vbytes
    get perKvb() { return st.perKvb; },
    // whole units of the fee asset per vbyte, as applyFeeUnits takes it
    get unitsPerVb() { const { precision } = m(); return st.perKvb / 1000 / Math.pow(10, precision); },
    get custom() { return st.mode === 'custom'; },
    // the verdict on the rate, { level, text, block } or null
    async check() { await verdict(); return st.last; },
    // the assets, the prices or the network moved
    refresh() { if (deps.hint) deps.hint(hex(), hintBox); recompute(); },
    // what is being paid changed: size it again
    resize,
    // the totals, for a caller that needs them (Max)
    totalFor(vsize) { return totalFromPerKvb(st.perKvb, vsize); },
  };
}

export const __test__ = { rateUnits, rateText, totalFromPerKvb, perKvbFromTotal, unitsToAtoms, atomsToUnits, fmtRefNum, refToAtoms, atomsToRef, btcEstimateFor };
