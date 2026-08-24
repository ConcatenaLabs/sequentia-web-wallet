// STAKING REWARD AUTO-CONVERSION — the wallet-side engine.
//
// The decisions themselves (which coins are rewards, which batches convert) are
// SWK's and are tested in Rust. What is tested here is the ORCHESTRATION around
// them, where the expensive mistakes live: selling the same reward twice,
// releasing coins after an ambiguous failure, or converting at all while the
// setting is off.
//
//   node --test rewards.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import {
  initRewards, rewardSettings, setRewardSettings, runAutoConvert, scanRewards,
  totalsOf, conversions, convertedOutpoints, sliceForWholeHtlc,
  NATIVE_BTC, DEFAULT_SETTINGS,
} from './rewards.js';

// A localStorage stand-in, per test.
function memStore(){
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

const GOLD = 'aa'.repeat(32);
const USDX = 'bb'.repeat(32);

// A stand-in for the SWK wasm bindings. It is deliberately dumb: the engine
// under test must not depend on WHAT it decides, only on how the answers are
// plumbed.
function fakeEngine({ rewards = [], batches = [], decision = null } = {}){
  const calls = { attribute: 0, plan: 0, decide: 0, lastAlready: null, lastSettings: null };
  return {
    calls,
    sequentiaCoinbaseMaturity: () => 1000,
    attributeStakingRewards(_txs, _keys, _tip, maturity){
      calls.attribute++;
      calls.lastMaturity = maturity;
      return rewards;
    },
    planRewardBatches(_rewardsJson, settingsJson, alreadyJson){
      calls.plan++;
      calls.lastAlready = JSON.parse(alreadyJson);
      calls.lastSettings = JSON.parse(settingsJson);
      return batches;
    },
    decideRewardConversion(){ calls.decide++; return decision; },
  };
}

function reward(txid, vout, asset, value, extra = {}){
  return {
    txid, vout, asset, value, source: 'solo', height: 10,
    blocksToMaturity: 0, mature: true, spent: false, ...extra,
  };
}

function batch(asset, inputs, value){ return { asset, inputs, value }; }

function setup({ engine, execute, quote = { receives: 50000, reference: 50000 } } = {}){
  const store = memStore();
  const executed = [];
  initRewards({
    engine,
    store,
    walletTxs: () => [{ txid: 'a'.repeat(64), height: 10, isCoinbase: true, fromMe: false, ownedOutputs: [] }],
    stakingKeys: () => [{ scriptPubkey: '0014' + '11'.repeat(20), pubkey: '02' + '22'.repeat(32), delegated: false }],
    tipHeight: () => 100,
    quoteFor: async () => quote,
    execute: execute || (async (plan) => { executed.push(plan); return { ok: true, txid: 'tx' + executed.length }; }),
    now: () => 1_700_000_000_000,
  });
  return { store, executed };
}

test('the setting is off by default, and nothing converts while it is', async () => {
  const engine = fakeEngine({ batches: [batch(GOLD, ['t:0'], 1000)], decision: { converts: true, receives: 50000 } });
  const { executed } = setup({ engine });

  assert.equal(rewardSettings().enabled, false, 'opt-in, always');
  assert.equal(rewardSettings().target, NATIVE_BTC, 'Bitcoin is the default target');

  const r = await runAutoConvert();
  assert.equal(r.ran, false);
  assert.equal(executed.length, 0);
  assert.equal(engine.calls.plan, 0, 'a disabled engine does not even plan');
});

test('an enabled pass converts a batch the engine approves', async () => {
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: true, receives: 50000 },
  });
  const { executed } = setup({ engine });
  setRewardSettings({ enabled: true });

  const r = await runAutoConvert();
  assert.equal(r.ran, true);
  assert.equal(r.converted.length, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].asset, GOLD);
  assert.deepEqual(executed[0].inputs, ['t1:0']);
  assert.equal(executed[0].target, NATIVE_BTC);

  const [c] = conversions();
  assert.equal(c.state, 'done');
  assert.equal(c.txid, 'tx1');
  assert.deepEqual(c.inputs, ['t1:0']);
});

test('a converted reward is never offered again', async () => {
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: true, receives: 50000 },
  });
  setup({ engine });
  setRewardSettings({ enabled: true });

  await runAutoConvert();
  await runAutoConvert();

  // The second pass must TELL the engine those coins are spoken for. This is
  // the whole idempotence: a reload mid-conversion, or a second tab, cannot
  // sell the same reward twice.
  assert.deepEqual(engine.calls.lastAlready, ['t1:0']);
});

test('a definite refusal releases the coins to be reconsidered', async () => {
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: true, receives: 50000 },
  });
  setup({ engine, execute: async () => ({ ok: false, error: 'no route' }) });
  setRewardSettings({ enabled: true });

  const r = await runAutoConvert();
  assert.equal(r.converted.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(conversions()[0].state, 'failed');
  // The sale did NOT happen, so the coins are free again.
  assert.deepEqual(convertedOutpoints(), []);
});

test('an AMBIGUOUS failure keeps the coins claimed', async () => {
  // An executor that throws may have paid before it threw. Releasing the coins
  // here is how a wallet double-sells, so the record stays pending and a human
  // sees it stuck instead.
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: true, receives: 50000 },
  });
  setup({ engine, execute: async () => { throw new Error('connection lost'); } });
  setRewardSettings({ enabled: true });

  const r = await runAutoConvert();
  assert.equal(r.errors.length, 1);
  assert.equal(conversions()[0].state, 'pending');
  assert.deepEqual(convertedOutpoints(), ['t1:0'], 'still claimed');
});

test('a batch the engine declines is reported, not dispatched', async () => {
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: false, decision: 'belowFloor', reason: 'Not yet worth converting.' },
  });
  const { executed } = setup({ engine });
  setRewardSettings({ enabled: true });

  const r = await runAutoConvert();
  assert.equal(executed.length, 0);
  assert.equal(r.considered.length, 1, 'the staker can see WHY nothing converted');
  assert.equal(r.considered[0].decision.reason, 'Not yet worth converting.');
  assert.equal(conversions().length, 0, 'nothing was committed to');
});

test('an unreadable book is a wait, not an error the staker must act on', async () => {
  const engine = fakeEngine({
    rewards: [reward('t1', 0, GOLD, 1000)],
    batches: [batch(GOLD, ['t1:0'], 1000)],
    decision: { converts: false, decision: 'noMarket', reason: 'No market for this pair right now.' },
  });
  const { executed } = setup({ engine });
  initRewards({
    ...pluck(),
    engine,
    quoteFor: async () => { throw new Error('relay down'); },
  });
  setRewardSettings({ enabled: true });

  const r = await runAutoConvert();
  assert.equal(executed.length, 0);
  // The engine was still ASKED, with a null quote, so the refusal is the
  // engine's own "no market" and reads the same to the user as an empty book.
  assert.equal(engine.calls.decide, 1);
  assert.equal(r.considered[0].quote, null);
});

test('a chosen non-BTC target reaches the engine as an asset id', async () => {
  const engine = fakeEngine({ batches: [], decision: null });
  setup({ engine });
  setRewardSettings({ enabled: true, target: USDX });

  await runAutoConvert();
  assert.equal(engine.calls.lastSettings.target, USDX);

  // ...and native BTC reaches it as null, which is how SWK spells it.
  setRewardSettings({ target: NATIVE_BTC });
  await runAutoConvert();
  assert.equal(engine.calls.lastSettings.target, null);
});

test('settings round-trip, and unknown keys do not erase the defaults', () => {
  const engine = fakeEngine();
  setup({ engine });
  setRewardSettings({ enabled: true, maxSlippageBp: 50 });
  const s = rewardSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.maxSlippageBp, 50);
  assert.equal(s.minReceive, DEFAULT_SETTINGS.minReceive, 'untouched settings keep their default');
  assert.deepEqual(s.exclude, []);
});

test('totals separate what is spendable from what is still maturing', () => {
  const t = totalsOf([
    reward('t1', 0, GOLD, 100),
    reward('t2', 0, GOLD, 250, { mature: false, blocksToMaturity: 40 }),
    reward('t3', 0, GOLD, 999, { spent: true }),
    reward('t4', 0, USDX, 7, { source: 'split' }),
  ]);
  const gold = t.find(x => x.asset === GOLD);
  assert.equal(gold.mature, 100n);
  assert.equal(gold.immature, 250n);
  assert.equal(gold.outputs, 3, 'a spent reward is still history worth counting');
  const usdx = t.find(x => x.asset === USDX);
  assert.equal(usdx.sources.split, 1);
});

test("the coinbase maturity comes from the kit, not from a literal", () => {
  // Sequentia's is 1,000 blocks, not Bitcoin's 100. A wallet that guessed would
  // call a reward spendable 900 blocks early and then build a transaction the
  // chain rejects -- which is exactly what this wallet did until a node on the
  // live testnet reported 941 blocks to maturity at 60 confirmations.
  const engine = fakeEngine({ rewards: [] });
  const { ctx } = { ctx: null };
  initRewards({
    ...pluck(),
    engine,
    walletTxs: () => [{ txid: 'a'.repeat(64), height: 10, isCoinbase: true, fromMe: false, ownedOutputs: [] }],
    stakingKeys: () => [{ scriptPubkey: '0014' + '11'.repeat(20), pubkey: '02' + '22'.repeat(32), delegated: false }],
  });
  scanRewards();
  assert.equal(engine.calls.lastMaturity, 1000);
});

test('a wallet with no staking keys and no coinbase does not bother the engine', () => {
  const engine = fakeEngine();
  initRewards({
    ...pluck(),
    engine,
    walletTxs: () => [{ txid: 'b'.repeat(64), height: 3, isCoinbase: false, fromMe: false, ownedOutputs: [] }],
    stakingKeys: () => [],
  });
  const r = scanRewards();
  assert.deepEqual(r.rewards, []);
  assert.equal(engine.calls.attribute, 0);
});

test('a whole-HTLC offer is clamped to the batch, never the other way round', () => {
  // The reverse rail picks the smallest offer that COVERS the request, so the
  // offer is routinely bigger than what staking paid. Taking it whole would
  // sell coins that were never rewards.
  assert.equal(sliceForWholeHtlc(5000n, 1000n), 1000n, 'a big offer sells only the batch');
  assert.equal(sliceForWholeHtlc(600n, 1000n), 600n, 'a small offer sells what it can; the rest waits');
  assert.equal(sliceForWholeHtlc(1000n, 1000n), 1000n);
  // Nothing to trade is NOT "take everything".
  assert.equal(sliceForWholeHtlc(0n, 1000n), 0n);
  assert.equal(sliceForWholeHtlc(5000n, 0n), 0n);
});

// The context the last two tests override one field of. Kept here rather than
// inline so the overrides read as the single difference they are.
function pluck(){
  const store = memStore();
  return {
    store,
    walletTxs: () => [],
    stakingKeys: () => [],
    tipHeight: () => 100,
    quoteFor: async () => ({ receives: 50000, reference: 50000 }),
    execute: async () => ({ ok: true, txid: 'tx' }),
    now: () => 1_700_000_000_000,
  };
}
