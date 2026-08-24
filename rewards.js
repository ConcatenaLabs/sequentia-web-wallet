// STAKING REWARD AUTO-CONVERSION — the wallet-side engine.
//
// A staker is paid the transaction fees of the blocks it earns from, and under
// the open fee market those arrive in whichever assets the payers chose. The
// result, for most stakers, is a long tail of small balances in assets they
// never chose to hold. This converts that tail into ONE asset the staker picked
// — native BTC by default and first in the picker, but not the only choice,
// because outside staking no asset is privileged.
//
// The specification is the node repo's doc/sequentia/reward-autoconvert-design.md,
// and the two decisions that must not differ between wallets — which coins are
// rewards, and which of them to sell — are NOT made here. They are made once, in
// SWK (`lwk_wollet::staking_rewards`), and reached through the wasm bindings this
// module is handed. This file is the ORCHESTRATION around them: gather the facts,
// ask for a quote, ask for the verdict, dispatch, and remember what was done.
//
// Everything is injected (`initRewards`), so the whole engine runs under `node
// --test` against fakes — see rewards.test.mjs. That matters more here than in
// most modules: the failure this code must never have is selling something that
// was not a reward, and a test that can only be run in a browser against a live
// book is a test nobody runs.

let C = null;

// One record per conversion the engine has started. `pending` means dispatched
// but not yet known to have succeeded; `done` means it did. BOTH exclude their
// inputs from further batching, which is the whole of the idempotence: a reload
// mid-conversion, or a second tab, cannot sell the same reward twice.
const LEDGER_KEY = 'seq.rewardConversions';
const SETTINGS_KEY = 'seq.rewardAutoConvert';

// Native parent-chain BTC is not an asset id, so it needs a sentinel. Never
// SBTC: a staker who asks for Bitcoin gets Bitcoin, and one who genuinely wants
// the peg picks it from the list like any other asset.
export const NATIVE_BTC = 'BTC';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,          // opt-in, always: converting rewards is irreversible
  target: NATIVE_BTC,
  exclude: [],             // asset ids to keep, on top of the target itself
  minReceive: '10000',     // atoms of the TARGET asset (0.0001 BTC)
  maxSlippageBp: 200,      // 2%
});

/**
 * Wire the engine.
 *
 * ctx:
 *   engine            the SWK wasm bindings: attributeStakingRewards,
 *                     planRewardBatches, decideRewardConversion
 *   walletTxs()       -> [{ txid, height, isCoinbase, fromMe, ownedOutputs:[
 *                          { vout, scriptPubkey, asset, value, spent } ] }]
 *   stakingKeys()     -> [{ scriptPubkey, pubkey, delegated }]
 *   tipHeight()       -> number
 *   quoteFor(a)       -> ({ asset, atoms, target }) => { receives, reference } | null
 *   execute(plan)     -> { ok, txid?, error? }   the wallet's own take path
 *   store             localStorage-alike (getItem/setItem)
 *   log(msg, extra)   optional
 */
export function initRewards(ctx){ C = ctx; }

function store(){
  return (C && C.store) || (typeof localStorage !== 'undefined' ? localStorage : null);
}

function readJSON(key, fallback){
  try {
    const s = store() && store().getItem(key);
    if (!s) return fallback;
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

function writeJSON(key, value){
  try { store() && store().setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- settings ----------

export function rewardSettings(){
  const s = readJSON(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    // Persisted values arrive as whatever JSON round-tripped; normalise the
    // ones the engine compares or arithmetic touches.
    exclude: Array.isArray(s.exclude) ? s.exclude.slice() : [],
    minReceive: String(s.minReceive ?? DEFAULT_SETTINGS.minReceive),
    maxSlippageBp: Number(s.maxSlippageBp ?? DEFAULT_SETTINGS.maxSlippageBp),
    enabled: !!s.enabled,
    target: s.target || DEFAULT_SETTINGS.target,
  };
}

export function setRewardSettings(patch){
  const next = { ...rewardSettings(), ...(patch || {}) };
  writeJSON(SETTINGS_KEY, next);
  return next;
}

/** The settings as SWK's `SettingsDto`: native BTC is `target: null` there. */
function settingsForEngine(s){
  return JSON.stringify({
    enabled: !!s.enabled,
    target: s.target === NATIVE_BTC ? null : s.target,
    exclude: s.exclude || [],
    minReceive: Number(s.minReceive),
    maxSlippageBp: Number(s.maxSlippageBp),
  });
}

// ---------- the conversion ledger ----------

export function conversions(){
  const l = readJSON(LEDGER_KEY, []);
  return Array.isArray(l) ? l : [];
}

/** Outpoints already committed to a conversion, pending or done. */
export function convertedOutpoints(){
  const out = [];
  for (const c of conversions()){
    if (c.state === 'pending' || c.state === 'done') out.push(...(c.inputs || []));
  }
  return out;
}

function recordConversion(rec){
  const l = conversions();
  l.unshift(rec);
  // A wallet does not need an unbounded history of its own housekeeping.
  writeJSON(LEDGER_KEY, l.slice(0, 200));
  return rec;
}

function settleConversion(id, patch){
  const l = conversions();
  const i = l.findIndex(c => c.id === id);
  if (i < 0) return null;
  l[i] = { ...l[i], ...patch };
  writeJSON(LEDGER_KEY, l);
  return l[i];
}

// ---------- layer 1: what did staking pay me ----------

/**
 * Every staking reward the wallet holds, newest first, and the per-asset totals
 * a staker actually wants to look at.
 *
 * The rule itself lives in SWK; this only assembles the facts it needs.
 */
export function scanRewards(){
  const txs = C.walletTxs() || [];
  const keys = C.stakingKeys() || [];
  // No staking keys and no coinbase means nothing here can be a reward, and
  // asking the engine would only spend time proving it.
  if (!keys.length && !txs.some(t => t.isCoinbase)) return { rewards: [], totals: [] };

  // The maturity comes from the kit, never a literal here. Sequentia's is 1,000
  // blocks, not Bitcoin's 100: the protection is a wall-clock one and this chain
  // runs at 60 seconds. A wallet that guessed 100 would call a reward spendable
  // 900 blocks early and then build a transaction the chain rejects.
  const maturity = (C.engine.sequentiaCoinbaseMaturity
    ? Number(C.engine.sequentiaCoinbaseMaturity())
    : 1000);
  const rewards = C.engine.attributeStakingRewards(
    JSON.stringify(txs),
    JSON.stringify(keys),
    Number(C.tipHeight() || 0),
    maturity,
  ) || [];

  return { rewards, totals: totalsOf(rewards) };
}

/** Per asset: what is spendable now, what is still maturing, and from where. */
export function totalsOf(rewards){
  const by = new Map();
  for (const r of rewards || []){
    let t = by.get(r.asset);
    if (!t){ t = { asset: r.asset, mature: 0n, immature: 0n, outputs: 0, sources: {} }; by.set(r.asset, t); }
    t.outputs++;
    t.sources[r.source] = (t.sources[r.source] || 0) + 1;
    const v = BigInt(r.value);
    if (r.spent) continue;              // spent rewards are history, not holdings
    if (r.mature) t.mature += v; else t.immature += v;
  }
  return [...by.values()].sort((a, b) => (b.mature + b.immature > a.mature + a.immature ? 1 : -1));
}

// ---------- layer 2 + 3: decide, then dispatch ----------

/**
 * One pass of the engine: batch what is convertible, quote each batch, take the
 * verdict, and dispatch the ones that convert.
 *
 * Returns a report of every batch considered and what happened to it, which is
 * also exactly what the UI shows — a staker should be able to see WHY nothing
 * converted, because "nothing happened" and "nothing should have happened" look
 * identical otherwise.
 *
 * Never throws for an ordinary "not now": no market, too small and too far from
 * the reference price are all WAITS. The coins stay where they are.
 */
export async function runAutoConvert({ dryRun = false } = {}){
  const settings = rewardSettings();
  const report = { ran: false, settings, considered: [], converted: [], errors: [] };
  if (!settings.enabled && !dryRun) return report;

  const { rewards } = scanRewards();
  const batches = C.engine.planRewardBatches(
    JSON.stringify(rewards),
    settingsForEngine(settings),
    JSON.stringify(convertedOutpoints()),
  ) || [];
  report.ran = true;

  for (const batch of batches){
    let quote = null;
    try {
      quote = await C.quoteFor({ asset: batch.asset, atoms: batch.value, target: settings.target });
    } catch (e) {
      // A book we could not read is not a book that said no. Treat it as "no
      // market for now" rather than an error the staker has to act on.
      quote = null;
      report.errors.push({ asset: batch.asset, error: String(e && e.message || e) });
    }

    const decision = C.engine.decideRewardConversion(
      JSON.stringify(batch),
      JSON.stringify(quote),
      settingsForEngine(settings),
    );
    const row = { batch, quote, decision };
    report.considered.push(row);
    if (!decision || !decision.converts || dryRun) continue;

    // Commit to the inputs BEFORE dispatching. If the wallet dies between here
    // and the executor returning, those coins stay claimed by a `pending`
    // record rather than being offered to a second conversion — the sale may
    // well have happened, and we cannot know.
    const rec = recordConversion({
      id: conversionId(batch),
      state: 'pending',
      at: nowMs(),
      asset: batch.asset,
      value: String(batch.value),
      target: settings.target,
      expected: String(decision.receives),
      inputs: batch.inputs.slice(),
    });

    try {
      const res = await C.execute({
        asset: batch.asset,
        atoms: batch.value,
        inputs: batch.inputs.slice(),
        target: settings.target,
        expected: decision.receives,
        maxSlippageBp: settings.maxSlippageBp,
      });
      if (res && res.ok){
        settleConversion(rec.id, { state: 'done', txid: res.txid || null, received: res.received != null ? String(res.received) : null });
        report.converted.push({ ...row, txid: res.txid || null });
      } else {
        // A definite refusal: the sale did NOT happen, so release the coins to
        // be reconsidered next pass.
        settleConversion(rec.id, { state: 'failed', error: String((res && res.error) || 'conversion did not complete') });
        report.errors.push({ asset: batch.asset, error: String((res && res.error) || 'conversion did not complete') });
      }
    } catch (e) {
      // An exception is NOT a definite refusal — the executor may have paid
      // before it threw. The record stays `pending`, so those coins are never
      // offered again, and a human can see it stuck rather than the wallet
      // quietly double-selling.
      settleConversion(rec.id, { error: String(e && e.message || e) });
      report.errors.push({ asset: batch.asset, error: String(e && e.message || e) });
    }
  }

  return report;
}

function nowMs(){ return (C && C.now) ? C.now() : Date.now(); }

/** Stable across a retry of the same coins, so a duplicate is visible as one. */
function conversionId(batch){
  return `${batch.asset}:${(batch.inputs || []).slice().sort().join(',')}`;
}

/**
 * How much of a batch a WHOLE-HTLC offer may take.
 *
 * The cross-chain reverse rail rests whole offers, and the offer picked is
 * deliberately the smallest one that COVERS the request — which can be far
 * larger than the batch. Taking it whole would sell much more than staking ever
 * paid, so the slice is clamped to the batch. Selling LESS is fine and normal:
 * the remainder waits for the next pass.
 *
 * Returns 0n when neither side has anything to trade, which the caller must
 * treat as "no fill", never as "take everything".
 */
export function sliceForWholeHtlc(offerAtoms, batchAtoms){
  const offer = BigInt(offerAtoms || 0n);
  const batch = BigInt(batchAtoms || 0n);
  if (offer <= 0n || batch <= 0n) return 0n;
  return offer < batch ? offer : batch;
}

/** A sentence for a decision a wallet can show as-is. SWK supplies the text. */
export function decisionText(decision){
  if (!decision) return '';
  if (decision.converts) return 'Converting…';
  return decision.reason || '';
}
