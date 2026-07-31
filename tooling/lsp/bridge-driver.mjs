// bridge-driver.mjs — the LIVE driver that EXECUTES a rail-crossing settlement, obeying the pure
// decision cores (settlement-router.mjs + leg-bridge.mjs) and never front-running them.
//
// WHERE THIS SITS:
//   • settlement-router.planSettlement(match)  -> WHICH legs cross (rail-blind matching).
//   • leg-bridge.nextBridgeStep(leg, obs)      -> the next SAFE action for ONE crossed leg.
//   • THIS module                              -> the loop that OBSERVES real state, asks
//                                                 nextBridgeStep, and executes EXACTLY its output,
//                                                 plus the whole-swap coordinator (JIT inbound first,
//                                                 the atomicity gate on the shared H, recoup-before-CLTV).
//
// It is I/O-FREE by construction: every side effect (LN hold pay/settle, on-chain HTLC fund/claim/
// refund/observe, JIT inbound, native-leg drive, the clock) arrives through an injected `io` object.
// So the fund-safety-critical CONTROL FLOW is unit-tested without a node — identical discipline to the
// pure cores it drives. The live LSP builds a REAL `io` (LN primitives + the seqob-cli HTLC commands)
// and hands it in; a test builds a scripted fake `io`. The driver's logic is the SAME either way.
//
// THE LOAD-BEARING INVARIANT (verify it survives every edit): the driver NEVER decides to move value on
// its own judgement. For a crossed leg it does ONLY what nextBridgeStep returns; a `wait`/unknown is a
// no-op sleep; a `fail-closed` aborts the leg (and, if anything was fronted, unwinds it via the core's
// own refund/recoup actions — never an ad-hoc spend). Because nextBridgeStep only ever fronts once the
// recoup is secured, the driver can only ever stall into a refundable no-loss failure, never steal.

import { nextBridgeStep, checkBridgeLocktimeOrdering } from './leg-bridge.mjs';
import { planSettlement } from './settlement-router.mjs';

export const DRIVER_DEFAULTS = Object.freeze({
  pollMs: 3000,          // how often to re-observe a leg between actions
  maxTicks: 100000,      // hard ceiling so a wedged observe can never spin forever (fails closed)
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map a nextBridgeStep action to the io method that performs it. Kept as a table (not a switch) so it
// is impossible for the driver to invent an action the core never returned: an action absent here is a
// no-op observation tick, never a value move.
const ACTION_IO = Object.freeze({
  'front-ln':       'frontLn',
  'fund-onchain':   'fundOnchain',
  'recoup-claim':   'recoupClaim',
  'recoup-settle':  'recoupSettle',
  'refund-onchain': 'refundOnchain',
  'refund-bump':    'refundBump',
});

/**
 * Drive ONE crossed leg to completion by repeatedly observing its two ends and executing EXACTLY the
 * action nextBridgeStep returns. Pure control-flow; all effects via `io`.
 *
 * @param {object} args
 * @param {{lnSide:'receiver'|'payer', amountSat:number, unit?:string}} args.leg
 * @param {{
 *   observe: () => Promise<{tip:number, onchain:object|null, ln:object}>,   // the leg's live state
 *   frontLn?: Function, fundOnchain?: Function,                              // value-front actions
 *   recoupClaim?: Function, recoupSettle?: Function, refundOnchain?: Function, refundBump?: Function,
 *   swapLocked?: () => boolean,   // whole-swap gate: are ALL OTHER legs locked? (default true)
 *   sleep?: (ms:number)=>Promise, log?: Function, signal?: {aborted:boolean},
 * }} args.io
 * @param {object} [args.cfg]  leg-bridge cfg overrides (frontRunway/claimMargin/holdBuffer)
 * @param {object} [args.driverCfg]  { pollMs, maxTicks }
 * @returns {Promise<{ok:boolean, reason:string, fronted:boolean, lastAction:string}>}
 */
export async function runBridgedLeg({ leg, io, cfg = {}, driverCfg = {} }) {
  if (!leg || (leg.lnSide !== 'receiver' && leg.lnSide !== 'payer'))
    throw new Error("runBridgedLeg: leg.lnSide must be 'receiver' or 'payer'");
  if (!io || typeof io.observe !== 'function') throw new Error('runBridgedLeg: io.observe is required');
  const d = { ...DRIVER_DEFAULTS, ...driverCfg };
  const nap = io.sleep || sleep;
  const log = io.log || (() => {});
  // fronted := has the LSP put value at stake on this leg yet? It flips true the instant we execute a
  // front-ln/fund-onchain, and it gates whether a fail-closed must unwind. (leg-bridge only ever
  // fail-closes BEFORE a front, so this stays false there; it is defence-in-depth, not the primary bar.)
  let fronted = false, lastAction = 'none', failStreak = 0, sameAction = 0;
  for (let tick = 0; tick < d.maxTicks; tick++) {
    if (io.signal && io.signal.aborted) return { ok: false, reason: 'aborted', fronted, lastAction };
    let obs;
    try { obs = await io.observe(); }
    catch (e) { log('[bridge-leg] observe failed, retrying:', e && e.message); await nap(d.pollMs); continue; }
    // Feed the whole-swap atomicity gate to the PURE core, so the front is withheld there (not by an
    // ad-hoc driver branch): the driver still executes exactly nextBridgeStep's output.
    if (io.swapLocked) obs = { ...obs, swapLocked: !!io.swapLocked() };
    // FRONTED-NESS IS DYNAMIC STATE, NOT CONSTRUCTION-TIME CONFIG.
    //
    // The caller builds this leg once, before the run starts — at which point no
    // fronting decision has been taken yet, so a flag captured there is frozen false
    // for the whole leg. The LSP decides to front DURING the first fund-onchain, and
    // from that instant the recoup rule changes (there is no BTC HTLC to read).
    //
    // Reading it once meant the step machine never took the fronted branch: it kept
    // returning fund-onchain against a job that had already fronted, re-entering the
    // front every few seconds and never recouping. Re-read it each tick.
    const tickLeg = (io.isFronted || io.assetRefundHeight)
      ? { ...leg,
          fronted: io.isFronted ? !!io.isFronted(leg) : leg.fronted,
          assetRefundHeight: io.assetRefundHeight ? Number(io.assetRefundHeight(leg)) : leg.assetRefundHeight }
      : leg;
    const step = nextBridgeStep(tickLeg, obs, cfg);
    // A repeating decision is the signature of a leg whose STATE the core cannot see
    // (a fronted job re-entering fund-onchain, say). Say what was decided and what it
    // was decided from, throttled, so that is diagnosable from the log alone.
    if (step.action === lastAction) sameAction++; else sameAction = 0;
    if (sameAction > 0 && sameAction % 10 === 0)
      log('[bridge-leg] still', step.action, `x${sameAction}`,
        '| fronted=', !!tickLeg.fronted, 'held=', !!(obs.ln && obs.ln.held),
        'P=', !!(obs.ln && obs.ln.preimage), 'ocFunded=', !!(obs.onchain && obs.onchain.funded));
    lastAction = step.action;
    if (step.action === 'done') { log('[bridge-leg] done:', step.reason); return { ok: true, reason: step.reason, fronted, lastAction }; }
    if (step.action === 'fail-closed') {
      // Nothing was fronted (the core only fail-closes before a front), so aborting is no-loss. If a
      // future core ever fail-closed AFTER a front, `fronted` surfaces it loudly for the operator.
      // FUND-SAFETY (funded payer leg NEVER dropped to terminal 'failed'): a PAYER leg has real on-chain
      // exposure (an LSP-funded BTC HTLC) recoverable only by settling the hold on P (revealed hours out,
      // beyond one driver session) or refunding at T_btc. So EVERY payer-leg fail-closed must stay RESUMABLE
      // (interrupted:true) — abandoning it as terminal would strand the funded BTC (never settled, never
      // refunded). Gate on lnSide ALONE, NOT `fronted && payer`: a leg RESUMED after a restart begins this
      // driver session with fronted=false, yet its BTC may already be funded from the PRIOR session — a
      // reorg near expiry (or any transient) that trips a fail-closed on that resumed leg would else be marked
      // terminal 'failed' and strand the fund. This now MATCHES the maxTicks rule below (payer => resumable).
      // Any RECEIVER-leg fail-closed (the core only fail-closes a receiver leg BEFORE fronting = no loss) stays
      // a genuine no-loss / operator-attention terminal — unchanged.
      const resumable = leg.lnSide === 'payer';
      log('[bridge-leg] FAIL-CLOSED', fronted ? '(AFTER a front — operator attention!)' : '(no value fronted this session)',
        resumable ? '(payer leg — RESUMABLE, re-driven on the next boot; BTC may be funded from a prior session)' : '', step.reason);
      return { ok: false, reason: step.reason, fronted, lastAction, interrupted: resumable };
    }
    const method = ACTION_IO[step.action];
    if (!method) { await nap(d.pollMs); continue; }   // 'wait' or anything unmapped -> observe again; NEVER a value move
    if (typeof io[method] !== 'function') return { ok: false, reason: `io.${method} not wired for action ${step.action}`, fronted, lastAction };
    if (step.action === 'front-ln' || step.action === 'fund-onchain') fronted = true;
    try {
      log('[bridge-leg] exec', step.action, '—', step.reason);
      await io[method](step, obs);
      failStreak = 0;   // this action got through — drop any backoff
    } catch (e) {
      // An execution error is NOT a decision to move value differently: re-observe and let the core
      // re-decide from the true on-chain/LN state (e.g. a broadcast that actually landed shows up as
      // funded; a genuinely failed front shows up as still-unfunded and is retried safely).
      //
      // BACK OFF ON A REPEATING FAILURE. Some failures never resolve: a payer leg whose maker offer is
      // permanently gone can never finish its relay half, yet its BTC is real and only refunds at T_btc —
      // possibly a day out. Retrying that at the poll interval for the whole session buys nothing and
      // buries every other job's output (three such jobs emitted two lines a second here, drowning the
      // log the operator needs). Keep retrying, because "gone" can also mean "the relay restarted", but
      // slow down geometrically so a permanently stuck leg costs one line a minute instead of forty.
      failStreak++;
      if (failStreak <= 3 || failStreak % 10 === 0)
        log('[bridge-leg]', step.action, 'raised, re-observing:', e && e.message,
          failStreak > 3 ? `(failed ${failStreak}x — backing off)` : '');
    }
    await nap(Math.min(d.pollMs * Math.max(1, 2 ** Math.min(failStreak, 5)), d.maxBackoffMs || 60000));
  }
  // maxTicks exhausted. RESUMABLE (marked 'interrupted' so resume-on-boot re-drives it, not 'failed' which
  // strands a committed leg) when EITHER:
  //   • nothing was fronted (no value at stake), for either side; OR
  //   • this is a PAYER leg that already FUNDED. The LSP fronted its OWN BTC on-chain, but P is the TAKER's
  //     secret, revealed hours out (T_seq/hold) — far beyond one driver session (maxTicks ~= mixedTimeoutMs,
  //     45min). A funded payer leg MUST stay resumable so the LSP can still recoup (settle the hold on P) or
  //     refund (at T_btc); abandoning it as terminal 'failed' would strand the fronted BTC (never settled,
  //     never refunded). For a RECEIVER leg a POST-front exhaustion is a genuine anomaly (the front already
  //     committed the LN + revealed the recoup path), so it stays a non-resumable failure — unchanged.
  const resumable = !fronted || leg.lnSide === 'payer';
  return { ok: false, reason: 'exceeded maxTicks without terminal state — failing closed', fronted, lastAction,
    interrupted: resumable };
}

// Split a settlement plan's two legs into { bridged, native, jit }. Each entry carries the router leg
// plus its unit ('btc'|'asset'). Amounts/keys are attached by the caller (they come from the match).
export function classifyLegs(plan) {
  const legs = [plan.btcLeg, plan.assetLeg].filter(Boolean);
  return {
    bridged: legs.filter((l) => l.bridge),
    native:  legs.filter((l) => !l.bridge),
    jit:     legs.filter((l) => l.jitInbound),
  };
}

/**
 * Coordinate a WHOLE bridged swap on the ONE shared preimage H.
 *
 * Ordering (this is the atomicity spine):
 *   0. JIT: provision inbound for every leg whose LN receiver lacks it, BEFORE anything locks.
 *   1. Kick off each NATIVE leg on the existing path (taker<->maker / the mapped xsub* CLI). The LSP is
 *      NOT in a native leg's value path; it only OBSERVES the leg's lock to gate the bridged front.
 *   2. Drive each CROSSED leg with runBridgedLeg, feeding it a swapLocked() gate = "every OTHER leg of
 *      this swap is locked". nextBridgeStep therefore WITHHOLDS the one value-front that reveals P until
 *      the whole swap is committed — so a partial (one leg reveals, another never locks) is impossible.
 *   3. Await all legs. Any crossed-leg fail-closed fails the swap (no value fronted, refundable).
 *
 * A leg is "locked" when, if P appeared now, it would settle and cannot be refunded out from under us:
 *   • native  -> io.observeNativeLocked(leg)  (maker funded the HTLC / the LN payment is held)
 *   • bridged -> its recoup is secured, i.e. nextBridgeStep(swapLocked:true) would front (not still
 *                waiting for its own recoup, and not failing). Computed via io.observe(leg) so no leg's
 *                readiness ever depends on another leg's FRONT — only on its lock — which rules out a
 *                mutual-wait deadlock when BOTH legs bridge.
 *
 * @param {object} args
 * @param {object} args.match       a planSettlement match ({asset, buyer, seller})
 * @param {object} args.io          whole-swap effects (see makeLegIo below) — one io per leg + provisionInbound
 * @param {object} [args.cfg]       leg-bridge cfg
 * @param {object} [args.driverCfg] driver cfg
 * @returns {Promise<{ok:boolean, plan:object, legs:object[], reason?:string}>}
 */
export async function runBridgedSwap({ match, io, cfg = {}, driverCfg = {} }) {
  const plan = planSettlement(match);
  if (plan.happyCoincidence) {
    // No leg crosses -> the LSP must NOT be in the value path. Refuse here so a coincident match can
    // never be silently routed through a bridge (and charged a bridge fee). The caller settles it
    // natively (the existing review/execute or xsub* dispatch).
    return { ok: false, plan, legs: [], reason: 'happy coincidence — settle natively, not via the bridge (the LSP is not a value-path counterparty here)' };
  }
  const d = { ...DRIVER_DEFAULTS, ...driverCfg };
  const nap = (io.sleep) || sleep;
  const log = io.log || (() => {});
  const { bridged, native, jit } = classifyLegs(plan);
  // The router leg does not carry the amount the front must be bounded to; the match does, surfaced via
  // io.legAmountSat(leg). Enrich each leg so nextBridgeStep's amount check (never front more than we
  // recoup) has a real bound. A missing legAmountSat is a wiring bug -> fail closed rather than front unbounded.
  const amtOf = (leg) => (io.legAmountSat ? Number(io.legAmountSat(leg)) : leg.amountSat);
  // `fronted` tells nextBridgeStep the LSP delivered this leg from its OWN inventory
  // rather than funding a BTC HTLC, so the recoup is "settle once the taker claims"
  // and not "read the fate of our BTC HTLC" (which does not exist). assetRefundHeight
  // is the T_seq that leg refunds at, so an unclaimed front can be reclaimed.
  const withAmt = (leg) => ({ lnSide: leg.lnSide, amountSat: amtOf(leg), unit: leg.unit, bridge: leg.bridge,
    jitInbound: leg.jitInbound,
    fronted: io.isFronted ? !!io.isFronted(leg) : false,
    assetRefundHeight: io.assetRefundHeight ? Number(io.assetRefundHeight(leg)) : 0 });

  // W2(a) — AUTHORITATIVE DRIVER-LIVENESS. Mark the driver LIVE for exactly the window it can still front,
  // and CLEAR it the instant the leg drivers stop (BELOW, before the post-loop awaits). The /bridge/asset
  // handler gates the taker's asset hand-off on THIS flag (via bridgeAssetHandoffAdmissible) instead of the
  // job.status, which LAGS termination by the post-loop awaits — a window in which a maxTicks-exhausted
  // driver (no front will ever happen) still shows status 'confirming', so relaying the asset would strand
  // it. `io.setDriverLive` is optional (bridge-driver stays node-free / job-agnostic; the live LSP io binds
  // it to job._driverLive). clearLive is idempotent and covers every exit — early return, throw, or normal.
  if (io.setDriverLive) io.setDriverLive(true);
  const clearLive = () => { if (io.setDriverLive) io.setDriverLive(false); };

  // 0. JIT inbound FIRST (an LN receiver with no inbound cannot receive at all). Fail closed on error:
  //    nothing is locked yet, so aborting is free.
  for (const leg of jit) {
    try { await io.provisionInbound(leg); log('[bridge-swap] JIT inbound provisioned for', leg.unit); }
    catch (e) { clearLive(); return { ok: false, plan, legs: [], reason: `JIT inbound for ${leg.unit} failed (fail closed, nothing locked): ${e && e.message}` }; }
  }

  // 1. Kick off native legs on the existing path. Non-blocking: they lock, then settle once P flows.
  const nativeRuns = native.map((leg) => ({ leg, p: Promise.resolve(io.startNative ? io.startNative(leg) : undefined) }));

  // The cross-leg lock oracle. `self` is excluded so a leg never gates on itself.
  const legKey = (l) => l.unit;
  async function legLocked(leg) {
    if (leg.bridge) {
      // Ready-to-front == recoup secured. Ask the core with swapLocked:true (ignore the whole-swap gate)
      // and treat a front/recoup/done as "locked"; a wait-for-recoup or fail as "not locked".
      let obs;
      try { obs = await io.observe(leg); } catch { return false; }
      const s = nextBridgeStep(withAmt(leg), { ...obs, swapLocked: true }, cfg);
      return s.action === 'front-ln' || s.action === 'fund-onchain'
          || s.action === 'recoup-claim' || s.action === 'recoup-settle' || s.action === 'done';
    }
    try { return !!(await io.observeNativeLocked(leg)); } catch { return false; }
  }
  // swapLocked for a given bridged leg = every OTHER leg locked. Cached per tick by the leg loop's own
  // re-observe cadence; here we compute it on demand from the live oracle.
  const otherLegsLocked = async (self) => {
    for (const l of plan.btcLeg && plan.assetLeg ? [plan.btcLeg, plan.assetLeg] : [plan.btcLeg, plan.assetLeg].filter(Boolean)) {
      if (!l || legKey(l) === legKey(self)) continue;
      if (!(await legLocked(l))) return false;
    }
    return true;
  };

  // 2. Drive each crossed leg, gated on the whole-swap lock. We snapshot the gate each observe tick via
  //    a synchronous flag the coordinator refreshes, so runBridgedLeg stays synchronous in swapLocked().
  const gate = new Map();   // unit -> boolean (is every OTHER leg locked?)
  for (const leg of bridged) gate.set(legKey(leg), false);
  let coordinating = true;
  const refresh = (async () => {
    while (coordinating) {
      for (const leg of bridged) {
        try { gate.set(legKey(leg), await otherLegsLocked(leg)); } catch { /* keep last */ }
      }
      await nap(Math.max(500, Math.floor(d.pollMs / 2)));
    }
  })();

  const bridgedRuns = bridged.map((leg) => runBridgedLeg({
    leg: withAmt(leg),
    io: legIoFor(io, leg, () => !!gate.get(legKey(leg))),
    cfg, driverCfg,
  }).then((r) => ({ leg, r })));

  let results;
  try {
    results = await Promise.all(bridgedRuns);
  } finally {
    // The leg drivers have stopped — CLEAR driver-liveness NOW, before the post-loop awaits below, so the
    // /bridge/asset gate refuses a hand-off the instant no driver will front it (closes the ~1.5s lag).
    clearLive();
  }
  coordinating = false; await refresh.catch(() => {});
  // Let native legs finish settling (they self-complete once P is public). Best-effort await.
  await Promise.allSettled(nativeRuns.map((n) => n.p));

  const failed = results.filter((x) => !x.r.ok);
  const legs = results.map((x) => ({ unit: x.leg.unit, ...x.r }));
  if (failed.length) {
    // The whole swap is INTERRUPTED (resumable) only if EVERY failed leg is a pre-front maxTicks
    // exhaustion (nothing fronted, nothing lost). A single genuine fail-closed / post-front failure makes
    // it a real failure that must NOT be silently resumed.
    const interrupted = failed.every((f) => f.r.interrupted === true);
    return { ok: false, plan, legs, interrupted,
      reason: failed.map((f) => `${f.leg.unit}: ${f.r.reason}`).join('; ') };
  }
  return { ok: true, plan, legs };
}

// W3(b) — does a rail-blind TAKE genuinely CROSS rails (i.e. REQUIRE a bridge)? Pure; used by the LSP
// /swap dispatch to REFUSE a crossed take that omitted bridge:true, which would otherwise misroute into
// the CUSTODIAL submarine path and move the LSP's OWN funds on an unrelated swap while reporting success.
// Returns false when the shape can't be determined (missing/invalid rails throw in matchFromTake) — the
// caller then falls through to its normal, individually-guarded dispatch rather than over-refusing.
export function takeRailsCrossed(take) {
  try {
    const plan = planSettlement(matchFromTake(take));
    return !plan.happyCoincidence;
  } catch { return false; }
}

// P3.2 — CROSSING-SHAPE CAPABILITY. A crossing may be REQUIRED (takeRailsCrossed/plan.bridged) yet not be
// one the LSP's live bridge io actually SETTLES. The LSP leg-bridge is the FALLBACK for an on-chain-only /
// passive maker (an interactive maker that accepts BTC-LN is settled PEER-TO-PEER instead — chooseSettlementPath).
// The bridge settles a BTC-leg crossing in BOTH directions, with the asset leg NATIVE (direct taker<->maker):
//   • lnSide 'receiver' — the taker SELLS the asset and RECEIVES BTC over Lightning (the LSP terminates the
//     taker's BTC-LN and CLAIMS the maker's on-chain BTC HTLC with the revealed P).
//   • lnSide 'payer'    — the taker BUYS the asset and PAYS BTC over Lightning (the LSP terminates the taker's
//     BTC-LN hold and FUNDS an on-chain BTC HTLC to the maker; the taker mints H and holds P).
// An asset-leg bridge (BTC leg native, asset leg crossed) is NOT wired here. This is the SINGLE source of
// truth for "is this crossing settleable" — the LSP's prepareBridgeLegs admission (`canBridge`) and the
// wallet's PRE-REVIEW check both call it, so a Review can never promise a bridge the LSP refuses
// post-confirm. Pure. `plan` is a planSettlement result.
export function crossingShapeSupported(plan) {
  if (!plan || plan.happyCoincidence) return false;   // not a crossing -> settle natively, not via the bridge
  const btc = plan.btcLeg, asset = plan.assetLeg;
  const btcBridged = !!(btc && btc.bridge), assetBridged = !!(asset && asset.bridge);
  // THE PREDICATE, STATED (it used to be one boolean expression whose asset-leg half read as an
  // afterthought). EXACTLY ONE leg may cross, and which one decides what the LSP has to be able to do:
  //   • BOTH cross          -> never. The LSP would have to be the counterparty on both ends of one H
  //                            with no leg left to recoup against; no shape here settles it.
  //   • the BTC leg crosses -> supported in BOTH lnSides. This is the live bridge: 'receiver' claims the
  //                            maker's on-chain BTC HTLC after fronting the taker's BTC-LN hold; 'payer'
  //                            funds an on-chain BTC HTLC to the maker against the taker's held BTC-LN.
  //   • the ASSET leg crosses, lnSide 'receiver' (the taker RECEIVES the asset over Lightning against an
  //                            ON-CHAIN maker) -> the gap. Settling it needs the LSP to DELIVER an asset
  //                            over Lightning and then be made whole, which is a capability it does not
  //                            have yet (see the note below). REFUSED here, deliberately, because this
  //                            predicate is a PERMISSION TO ENTER the bridge that Review reads: widening
  //                            it before the delivery+recoup io exists turns an honest disable into an
  //                            offer-then-refuse, which is worse than the gap.
  //   • the ASSET leg crosses, lnSide 'payer' (the taker PAYS the asset over Lightning to an on-chain
  //                            maker) -> not wired either; the LSP would have to originate an on-chain
  //                            asset HTLC against a received asset hold.
  //
  // FLIPPING THE ASSET-RECEIVER BRANCH. It becomes `return true` the moment the LSP can (1) pay a
  // bare-hash asset hold over Lightning from its own asset node — getroute `asset=<id>` + sendpay +
  // waitsendpay, with the private-channel single-hop fallback, mirroring seqdex clnLNLeg.PayHash — and
  // (2) recoup what it delivered. Nothing below this line has to change: nextBridgeStep still refuses to
  // front until the recoup is secured, so the predicate can only ever admit a shape, never authorise a
  // value move.
  if (btcBridged && assetBridged) return false;
  if (btcBridged) return btc.lnSide === 'receiver' || btc.lnSide === 'payer';
  return false;
}

// P3.2 — the wallet's pre-Review verdict for a rail-blind TAKE: does this crossing settle on the LSP's
// bridge? Match-based wrapper over crossingShapeSupported so the wallet composer can FALL BACK to the
// native/on-chain path (same price) instead of promising a bridge that fails post-confirm. Fails safe:
// an undeterminable shape (bad rails throw in matchFromTake) returns false -> the wallet does not promise
// a bridge. Never throws.
export function bridgedTakeSupported(take) {
  try { return crossingShapeSupported(planSettlement(matchFromTake(take))); }
  catch { return false; }
}

// P3.2 — the LSP capability descriptor published on /status, so any client (Ambra, future wallets) can
// read what crossing shapes the bridge settles WITHOUT re-deriving the wired-shape predicate. Enumerated
// over the four taker rail combinations against a unified-book maker (BTC leg on-chain; asset leg follows
// the offer rail), tagging each genuine crossing supported/unsupported via the ONE predicate above. Pure.
export function describeCrossingSupport() {
  const shapes = [];
  for (const side of ['buy', 'sell'])
    for (const payRail of ['ln', 'chain'])
      for (const recvRail of ['ln', 'chain'])
        for (const makerAssetRail of ['ln', 'chain']) {
          let plan;
          try { plan = planSettlement(matchFromTake({ asset: 'x', side, payRail, recvRail, makerBtcRail: 'chain', makerAssetRail })); }
          catch { continue; }
          if (plan.happyCoincidence) continue;   // only genuine crossings appear
          shapes.push({ side, payRail, recvRail, makerAssetRail, supported: crossingShapeSupported(plan) });
        }
  return {
    wired_shape: 'a BTC-leg rail crossing with a NATIVE asset leg, BOTH directions: taker SELLS the asset and RECEIVES BTC over Lightning (BTC leg bridged LN-receiver, vs an on-chain reverse maker), OR taker BUYS the asset and PAYS BTC over Lightning (BTC leg bridged LN-payer, vs an on-chain forward maker)',
    supported_crossings: shapes.filter((s) => s.supported),
    unsupported_crossings: shapes.filter((s) => !s.supported),
  };
}

// W2(a) — the /bridge/asset admission predicate. The taker's asset hand-off is accepted ONLY while a
// bridged driver is authoritatively LIVE to front it (job._driverLive, set/cleared synchronously with
// runBridgedSwap above) AND the courier session that relays the leg to the maker is still open. Gating on
// this — NOT the lagging job.status — closes the window where a maxTicks-exhausted driver's post-loop
// awaits still show status 'confirming' (+ a non-null session) yet no front will ever happen, so relaying
// the asset would hand it to the maker and strand the taker. Pure; shared by the handler and its test.
export function bridgeAssetHandoffAdmissible(job) {
  return !!(job && job._driverLive === true && job._bridgeSession);
}

// W2 — FRONT-BEFORE-FUND admission. The reordered (fund-safe) flow fronts the taker's BTC-LN hold BEFORE the
// taker exposes its asset, so /bridge/asset must REJECT any asset hand-off that arrives BEFORE the front is
// confirmed — otherwise a taker could fund + relay its asset (exposing it to the maker's P-claim) while the
// LSP has not yet paid, reintroducing the exact hole this fixes (asset gone, no incoming LN = taker loss).
// "Fronted" == the LSP's pay on H is committed toward the taker's hold (job.legState.btc.frontHeld) or the
// front has already settled (frontPreimage learned). Absent both -> not fronted -> refuse the relay (fail
// closed; the taker has funded nothing it cannot refund). Pure; shared by the handler and its test.
export function bridgeFrontConfirmed(job) {
  const sb = job && job.legState && job.legState.btc;
  if (!sb) return false;
  if (sb.frontHeld === true) return true;
  return typeof sb.frontPreimage === 'string' && /^[0-9a-f]{64}$/i.test(sb.frontPreimage);
}

// W2(a) — the RELAY-time LOCKTIME verdict for /bridge/asset. The taker's asset leg becomes EXPOSED to the
// maker's claim the INSTANT it is relayed (the maker can then claim it with P and reveal P; the taker can
// no longer be protected by anything but its own T_seq asset refund). So the SAME block-based locktime
// ordering the front enforces MUST also gate the relay — and against LIVE tips, because a short T_btc may
// have DRIFTED into the danger window since the handshake gate passed. This reads the two CLTV refund
// heights from the SAME job fields the front-time gate uses (the maker BTC HTLC's CLTV; the taker asset
// HTLC's refund height T_seq) and defers the decision to checkBridgeLocktimeOrdering against the LIVE btc +
// seq tips the handler just read — one BTC-time assumption, requiredTakerBlocks vs recoupDeadlineBlocks. A
// refusal => DO NOT relay (fail closed): the taker keeps its asset and refunds at T_seq. Pure (the handler
// does the I/O of reading tips); shared with its test. An unreadable tip arrives here as NaN and the gate
// fails closed — never relay on an unverifiable ordering.
export function bridgeAssetRelayLocktimeVerdict({ job, btcTip, seqTip, cfg } = {}) {
  const sbHtlc = (job && job.legState && job.legState.btc && job.legState.btc.htlc) || {};
  const saState = (job && job.legState && job.legState.asset) || {};
  const btcRefundHeight = Number(sbHtlc.cltv);
  const seqRefundHeight = Number(saState.seqLocktime ?? (job && job.bridge_terms && job.bridge_terms.seq_locktime));
  return checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip, seqRefundHeight, cfg });
}

// W3(c) — a ln/ln take is the UNCHANGED pure-LN route ONLY when it is NOT a bridged take. A genuine
// bridged take can carry BOTH taker rails on Lightning (the resting MAKER's rails differ, so a leg still
// crosses); it MUST fall through to the bridged driver, never be swallowed by pure-LN runSwap — which
// would settle an UNRELATED swap over the shared node and falsely report 'settled'. Pure; shared by the
// LSP /swap dispatch and its test so the ordering bug (ln/ln branch firing before the bridge branch, with
// no bridge exemption) cannot silently regress.
export function isPureLnTake({ payRail, recvRail, bridge }) {
  return payRail === 'ln' && recvRail === 'ln' && bridge !== true;
}

// Build the per-leg io view runBridgedLeg expects from the whole-swap io, binding the swapLocked gate.
function legIoFor(io, leg, swapLockedFn) {
  const bind = (name) => (typeof io[name] === 'function' ? (step, obs) => io[name](leg, step, obs) : undefined);
  return {
    observe: () => io.observe(leg),
    frontLn: bind('frontLn'), fundOnchain: bind('fundOnchain'),
    recoupClaim: bind('recoupClaim'), recoupSettle: bind('recoupSettle'), refundOnchain: bind('refundOnchain'),
    refundBump: bind('refundBump'),
    swapLocked: swapLockedFn,
    sleep: io.sleep, log: io.log, signal: io.signal,
  };
}

// Build a planSettlement match from a rail-blind TAKE: the taker's chosen rails + the resting offer's
// rails. Used identically by the wallet (to decide happy-coincidence vs cross, and to render honest net
// terms) and the LSP /swap dispatch (to drive the bridge) — ONE source of truth so both agree on which
// legs cross. The taker is the buyer on a 'buy' and the seller on a 'sell'; the maker is the other side.
// A resting maker's LN leg is served by its always-on hosted node, so it is assumed to hold inbound
// (no JIT for the maker) unless told otherwise; only the TAKER may need a JIT open.
export function matchFromTake({
  asset, side, payRail, recvRail, makerBtcRail, makerAssetRail,
  takerAssetInbound = false, takerBtcInbound = false, makerAssetInbound = true, makerBtcInbound = true,
}) {
  assertR(payRail, 'payRail'); assertR(recvRail, 'recvRail');
  assertR(makerBtcRail, 'makerBtcRail'); assertR(makerAssetRail, 'makerAssetRail');
  if (side === 'buy') {
    // taker BUYS: pays BTC on payRail, receives the asset on recvRail.
    return { asset,
      buyer:  { btcRail: payRail, assetRail: recvRail, assetInbound: !!takerAssetInbound },
      seller: { assetRail: makerAssetRail, btcRail: makerBtcRail, btcInbound: !!makerBtcInbound } };
  }
  if (side === 'sell') {
    // taker SELLS: pays the asset on payRail, receives BTC on recvRail.
    return { asset,
      seller: { assetRail: payRail, btcRail: recvRail, btcInbound: !!takerBtcInbound },
      buyer:  { btcRail: makerBtcRail, assetRail: makerAssetRail, assetInbound: !!makerAssetInbound } };
  }
  throw new Error("matchFromTake: side must be 'buy' or 'sell'");
}
function assertR(r, w) { if (r !== 'ln' && r !== 'chain') throw new Error(`matchFromTake: ${w} must be 'ln' or 'chain' (got ${JSON.stringify(r)})`); }

// The BTC amount a PAYER-bridge boot-resume must drive off. Pure. Fund-safety: resume MUST bind the leg to the
// ACTUAL funded amount (a persisted on-chain fact — legState.btc.amountSat, set from the verified terms and
// funded on-chain) and NEVER the maker-STATED bridge_terms.btc_amount, which a 0-price maker could have set to 0
// (or NaN) while the LSP still funded the real price. Falls back to the recorded HTLC output amount, then 0 —
// never to the maker-stated terms. `sbtc` is job.legState.btc.
export function fundedBtcSatsForResume(sbtc) {
  const amt = Number(sbtc && sbtc.amountSat);
  if (Number.isFinite(amt) && amt > 0) return amt;
  const htlcAmt = Number(sbtc && sbtc.htlc && sbtc.htlc.amount);
  if (Number.isFinite(htlcAmt) && htlcAmt > 0) return htlcAmt;
  return 0;
}

// Derive a unified-book offer's per-leg maker rails.
//
// ⚠ THIS DELIBERATELY REPORTS A SUBMARINE MAKER'S BTC LEG AS ON-CHAIN, which is not what
// the maker literally does (a submarine maker takes its BTC over Lightning). It is not an
// oversight, and changing it to the literal truth BREAKS ROUTING — verified: with both
// sides' rails agreeing, planSettlement reports a happyCoincidence and
// chooseSettlementPath short-circuits to 'native', losing the p2p-submarine path that
// this exact shape requires.
//
// What the router means by a leg "crossing" is "the two sides settle this leg through
// different mechanisms and something must bridge them" — and a BTC-LN payment against an
// on-chain asset HTLC needs the submarine protocol whether or not the two parties agree
// about which rail each leg uses. Reporting 'chain' here is how that requirement reaches
// the router.
//
// The honest fix is for planSettlement to distinguish "no rail conversion needed" from
// "no cross-network protocol needed", at which point this can state the literal rails.
// Until then, do not "correct" this function in isolation: see maker-rails.test.mjs,
// which pins the routing outcomes that actually matter.
export function makerRailsFromOffer(offer) {
  const railLn = !!offer && (offer.rail === 'ln');
  return { makerBtcRail: 'chain', makerAssetRail: railLn ? 'ln' : 'chain' };
}


// A convenience describer for the wallet's HONEST net-terms display: does this match need a bridge
// and/or a JIT open, and on which legs. Pure; no fees computed here (the caller adds its fee model).
export function describeBridge(match) {
  const plan = planSettlement(match);
  const { bridged, jit } = classifyLegs(plan);
  return {
    bridged: !plan.happyCoincidence,
    happyCoincidence: plan.happyCoincidence,
    bridgeLegs: bridged.map((l) => ({ unit: l.unit, lnSide: l.lnSide })),
    jitLegs: jit.map((l) => l.unit),
    lspInValuePath: !plan.happyCoincidence || jit.length > 0,
  };
}
