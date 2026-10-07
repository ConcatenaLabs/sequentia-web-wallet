// stake-records.js against fakes: the rules that decide what the wallet signs
// and when. tooling/stake-records-regtest.mjs runs the same module against a
// real node; this runs without one.
import { test } from 'node:test';
import assert from 'node:assert';
import * as SR from './stake-records.js';

const ME = '02' + '11'.repeat(32), P = '03' + '22'.repeat(32), Q = '02' + '33'.repeat(32);
const signing = (tip, v2) => (tip + 1 >= v2 ? 'segwitV0' : 'legacy');

// A fake SWK: transactions are JSON, scripts are hex tags.
const lwk = {
  stakeRecordSigning: (_n, tip, v2) => signing(tip, v2 ?? 163000),
  sequentiaStakeScript: (pub, csv) => 'aa' + pub + csv.toString(16).padStart(4, '0'),
  sequentiaUnbondScript: (pub) => 'bb' + pub,
  sequentiaDelegationScript: (pub, sg) => 'cc' + pub + sg,
  unbondFeeCap: (v) => String(BigInt(v) / 100n),
  findDelegationRecords: (hex, mine) => JSON.parse(hex).records.filter((r) => r.controller === mine)
    .map((r) => ({ vout: r.vout, signer: r.signer, value: r.value })),
  buildDelegationCreateTx: (r) => ({ rawHex: JSON.stringify({ records: [{ controller: ME, signer: r.signer, vout: 0, value: r.recordValue }] }),
    txid: 'create-' + r.signer.slice(0, 4), changeValue: '0' }),
  buildDelegationSpendTx: (r) => ({ rawHex: 'spend', txid: 'spend', signing: signing(r.tipHeight, r.recordsV2Height ?? 163000), recipe: r }),
  buildUnbondTx: (r) => ({ rawHex: 'unbond', txid: 'unbond', signing: signing(r.tipHeight, r.recordsV2Height ?? 163000), recipe: r }),
  buildUnbondClaimTx: (r) => ({ rawHex: 'claim', txid: 'claim', signing: signing(r.tipHeight, r.recordsV2Height ?? 163000), recipe: r }),
  findDelegationRecordsOk: true,
};

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

// An explorer answering from a table of path -> body (404 when absent).
function explorer(table) {
  return async (path) => {
    if (!(path in table)) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    const v = table[path];
    return { ok: true, status: 200, json: async () => v, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) };
  };
}

function ctx(over = {}) {
  return {
    lwk, network: {}, mnemonic: () => 'seed', stakerPublicKey: () => ME, stakerScript: () => '0014' + 'ab'.repeat(20),
    esplora: explorer({}), broadcast: async () => 'txid', signAuthorization: async () => ({ hex: 'auth', txid: 'auth' }),
    tipHeight: async () => 100, recordsV2Height: 163000, feeRate: 2000, hints: () => [[], []],
    anchorHeightOf: async () => null, spendAnchorHeight: async () => null, unbondDepth: 2016,
    store: memStore(), stakesKey: 'stakes', ...over,
  };
}

test('no chain tip, no signature: every spend refuses rather than guessing', async () => {
  for (const tipHeight of [async () => 0, async () => undefined, async () => { throw new Error('offline'); }]) {
    const c = ctx({ tipHeight });
    await assert.rejects(SR.chainTip(c), /could not read the chain tip/);
    await assert.rejects(SR.buildMove(c, { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, Q), /chain tip/);
    await assert.rejects(SR.buildLeave(c, { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, 'addr'), /chain tip/);
    await assert.rejects(SR.prepareJoin(c, P), /chain tip/);
  }
});

test('the tip and the records-v2 height reach the builder', async () => {
  const built = await SR.buildMove(ctx({ tipHeight: async () => 162998 }), { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, Q);
  assert.strictEqual(built.recipe.tipHeight, 162998);
  assert.strictEqual(built.recipe.locktime, 162998);
  assert.strictEqual(built.recipe.recordsV2Height, 163000);
  assert.strictEqual(built.signing, 'legacy');
  const after = await SR.buildMove(ctx({ tipHeight: async () => 162999 }), { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, Q);
  assert.strictEqual(after.signing, 'segwitV0');
});

test('a block crossing the fork height while a spend is built makes it build again', async () => {
  let reads = 0;
  const tips = [162998, 162999, 162999, 162999];
  const built = await SR.buildLeave(ctx({ tipHeight: async () => tips[Math.min(reads++, 3)] }),
    { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, 'addr');
  assert.strictEqual(built.signing, 'segwitV0');
  assert.ok(reads >= 3);
});

test('a builder that signs the wrong way is refused, not broadcast', async () => {
  const bad = { ...lwk, buildDelegationSpendTx: () => ({ rawHex: 'x', txid: 'x', signing: 'legacy' }) };
  await assert.rejects(SR.buildLeave(ctx({ lwk: bad, tipHeight: async () => 170000 }),
    { txid: 't', vout: 0, atoms: 100000n, signer: P, confirmed: true }, 'addr'), /refusing to broadcast/);
});

test('a join is persisted before either transaction is broadcast', async () => {
  const store = memStore();
  const seen = [];
  const c = ctx({ store, broadcast: async (hex) => { seen.push([hex, store.getItem(SR.PENDING_JOIN_KEY) != null]); return 'id'; } });
  const p = await SR.prepareJoin(c, P);
  assert.strictEqual(p.recordAtoms, SR.RECORD_ATOMS);
  await SR.commitJoin(c, p);
  assert.deepStrictEqual(seen.map((s) => s[1]), [true, true]);
  assert.deepStrictEqual(seen.map((s) => s[0]), ['auth', p.createHex]);
  await assert.rejects(SR.prepareJoin(c, ME), /your own staking key/);
  await assert.rejects(SR.prepareJoin(c, 'nonsense'), /66-character/);
});

test('a join in flight: rebroadcast, retired once confirmed, abandoned when it can never be mined', async () => {
  const store = memStore();
  store.setItem(SR.PENDING_JOIN_KEY, JSON.stringify({ authHex: 'auth', authTxid: 'a', createHex: '{}', createTxid: 'c', time: 0 }));
  const sent = [];
  assert.strictEqual(await SR.resumeJoin(ctx({ store, broadcast: async (h) => { sent.push(h); return 'x'; } })), 'rebroadcast');
  assert.deepStrictEqual(sent, ['auth', '{}']);
  assert.strictEqual(await SR.resumeJoin(ctx({ store, esplora: explorer({ '/tx/c/status': { confirmed: false } }) })), 'waiting');
  assert.strictEqual(await SR.resumeJoin(ctx({ store, broadcast: async () => { throw new Error('bad-txns-inputs-missingorspent'); } })), 'abandoned');
  assert.strictEqual(store.getItem(SR.PENDING_JOIN_KEY), null);
  store.setItem(SR.PENDING_JOIN_KEY, JSON.stringify({ createTxid: 'c', time: 0 }));
  assert.strictEqual(await SR.resumeJoin(ctx({ store, esplora: explorer({ '/tx/c/status': { confirmed: true } }) })), 'confirmed');
  assert.strictEqual(store.getItem(SR.PENDING_JOIN_KEY), null);
});

test('the record created from the staking key coin is found through that key history', async () => {
  const spk = '0014' + 'ab'.repeat(20);
  const sh = await SR.scriptHash(spk);
  const createHex = JSON.stringify({ records: [{ controller: ME, signer: P, vout: 0, value: '99480' }] });
  const c = ctx({ esplora: explorer({
    [`/scripthash/${sh}/txs`]: [
      { txid: 'reward', vin: [{ is_coinbase: true }], status: { confirmed: true, block_height: 9 } },
      { txid: 'create', vin: [{ is_coinbase: false, prevout: { scriptpubkey: spk } }], status: { confirmed: true, block_height: 8 } },
      { txid: 'auth', vin: [{ is_coinbase: false, prevout: { scriptpubkey: '0014' + 'cd'.repeat(20) } }], status: { confirmed: true, block_height: 8 } },
    ],
    '/tx/create/hex': createHex,
    '/tx/create/outspend/0': { spent: false },
    '/tx/create/status': { confirmed: true, block_height: 8 },
  }) });
  const d = await SR.findDelegation(c);
  assert.deepStrictEqual({ txid: d.txid, vout: d.vout, signer: d.signer, atoms: d.atoms, confirmed: d.confirmed },
    { txid: 'create', vout: 0, signer: P, atoms: 99480n, confirmed: true });
});

test('a spent record is not taken for the live one; the probe finds the moved record', async () => {
  const spk = '0014' + 'ab'.repeat(20);
  const sh = await SR.scriptHash(spk);
  const qsh = await SR.scriptHash('cc' + ME + Q);
  const table = {
    [`/scripthash/${sh}/txs`]: [{ txid: 'create', vin: [{ prevout: { scriptpubkey: spk } }], status: { confirmed: true, block_height: 8 } }],
    '/tx/create/hex': JSON.stringify({ records: [{ controller: ME, signer: P, vout: 0, value: '99480' }] }),
    '/tx/create/outspend/0': { spent: true, txid: 'move' },
    [`/scripthash/${qsh}/utxo`]: [{ txid: 'move', vout: 0, value: 98880, status: { confirmed: true, block_height: 9 } }],
    '/tx/move/status': { confirmed: true },
  };
  assert.strictEqual(await SR.findDelegation(ctx({ esplora: explorer(table) })), null);
  const d = await SR.findDelegation(ctx({ esplora: explorer(table), hints: () => [[Q], []] }));
  assert.strictEqual(d.txid, 'move');
  assert.strictEqual(d.signer, Q);
});

test('a stake goes bonded, unbondable, unbonding, claimable, claiming, claimed', async () => {
  const entry = { pubkey: ME, csv: 43200, atoms: '4000000000000', txid: 'bond' };
  const stakeSpk = lwk.sequentiaStakeScript(ME, 43200), unbondSpk = lwk.sequentiaUnbondScript(ME);
  const bondTx = { txid: 'bond', vout: [{ scriptpubkey: '0014ff', value: 5 }, { scriptpubkey: stakeSpk, value: 4000000000000 }],
                   status: { confirmed: true, block_height: 1000 } };
  const t = { '/tx/bond': bondTx, '/tx/bond/outspend/1': { spent: false } };
  let s = await SR.stakeState(ctx({ esplora: explorer(t) }), entry, 1000 + 43198);
  assert.deepStrictEqual([s.state, s.maturesAt, s.stake.vout], ['bonded', 44200, 1]);
  await assert.rejects(SR.buildUnbond(ctx(), s), /cannot be unbonded yet/);
  s = await SR.stakeState(ctx({ esplora: explorer(t) }), entry, 1000 + 43199);
  assert.strictEqual(s.state, 'unbondable');
  const ub = await SR.buildUnbond(ctx(), s);
  assert.strictEqual(ub.recipe.stakes[0].script, stakeSpk);
  assert.strictEqual(ub.recipe.feeAtoms, '540');           // 270 vB at 2 atoms a vbyte, under the 1% cap

  t['/tx/bond/outspend/1'] = { spent: true, txid: 'ub' };
  t['/tx/ub'] = { txid: 'ub', vout: [{ scriptpubkey: unbondSpk, value: 3999999999460 }], status: { confirmed: false } };
  s = await SR.stakeState(ctx({ esplora: explorer(t) }), entry, 50000);
  assert.deepStrictEqual([s.state, s.claimableAt], ['unbonding', null]);

  t['/tx/ub'].status = { confirmed: true, block_height: 50001, block_hash: 'h' };
  t['/tx/ub/outspend/0'] = { spent: false };
  const at = (tipAnchor) => ctx({ esplora: explorer(t), anchorHeightOf: async (h) => (h === 'h' ? 120000 : null), spendAnchorHeight: async () => tipAnchor });
  s = await SR.stakeState(at(122015), entry, 50002);
  assert.deepStrictEqual([s.state, s.claimableAt], ['unbonding', 122016]);
  await assert.rejects(SR.buildClaim(ctx(), s, 'addr'), /cannot be claimed yet/);
  s = await SR.stakeState(at(122016), entry, 50003);
  assert.strictEqual(s.state, 'claimable');
  const cl = await SR.buildClaim(ctx(), s, 'addr');
  assert.deepStrictEqual(cl.recipe.unbonding, [{ txid: 'ub', vout: 0, value: '3999999999460' }]);

  t['/tx/ub/outspend/0'] = { spent: true, txid: 'cl', status: { confirmed: false } };
  assert.strictEqual((await SR.stakeState(at(122016), entry, 50004)).state, 'claiming');
  t['/tx/ub/outspend/0'].status = { confirmed: true };
  assert.strictEqual((await SR.stakeState(at(122016), entry, 50005)).state, 'claimed');
});

test('an unread anchor never reads as claimable', async () => {
  const entry = { pubkey: ME, csv: 5, txid: 'bond' };
  const t = {
    '/tx/bond': { vout: [{ scriptpubkey: lwk.sequentiaStakeScript(ME, 5), value: 10 }], status: { confirmed: true, block_height: 1 } },
    '/tx/bond/outspend/0': { spent: true, txid: 'ub' },
    '/tx/ub': { vout: [{ scriptpubkey: lwk.sequentiaUnbondScript(ME), value: 9 }], status: { confirmed: true, block_hash: 'h' } },
    '/tx/ub/outspend/0': { spent: false },
  };
  for (const [a, sp] of [[null, 999999], [-1, 999999], [10, null]]) {
    const s = await SR.stakeState(ctx({ esplora: explorer(t), anchorHeightOf: async () => a, spendAnchorHeight: async () => sp }), entry, 100);
    assert.strictEqual(s.state, 'unbonding', `anchor ${a}, tip anchor ${sp}`);
  }
});

test('a stake spent some other way is not shown as unbonding', async () => {
  const entry = { pubkey: ME, csv: 5, txid: 'bond' };
  const t = {
    '/tx/bond': { vout: [{ scriptpubkey: lwk.sequentiaStakeScript(ME, 5), value: 10 }], status: { confirmed: true, block_height: 1 } },
    '/tx/bond/outspend/0': { spent: true, txid: 'restake' },
    '/tx/restake': { vout: [{ scriptpubkey: lwk.sequentiaStakeScript(ME, 5), value: 9 }], status: { confirmed: true } },
  };
  assert.strictEqual((await SR.stakeState(ctx({ esplora: explorer(t) }), entry, 100)).state, 'left');
});

test('feature probes name every entry point each flow needs', () => {
  assert.ok(SR.delegationSupported(lwk));
  assert.ok(SR.unbondingSupported(lwk));
  const old = { ...lwk }; delete old.buildDelegationCreateTx;
  assert.ok(!SR.delegationSupported(old));
  const older = { ...lwk }; delete older.buildUnbondClaimTx;
  assert.ok(!SR.unbondingSupported(older));
});
