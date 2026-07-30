// A FAILED JOB MUST BE READABLE.
//
// The wallet kept a record in "confirming" long after the LSP had already failed the
// job behind it. The reconciler that exists to catch exactly this ran on every render
// and found nothing, because of a single interaction between two locally-correct rules:
//
//   lspFetch throws whenever the body carries ok:false, and
//   a FAILED job answers {ok:false, status:'failed', error:'...'}.
//
// So the one probe that most needed to see a failure was the only one guaranteed to
// throw instead of returning it — and the reconciler's catch swallowed it silently.
// This pins the status read as a READ: ok:false is data, not an exception.
//
//   node --test job-reconcile.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSeqln, seqlnJobStatus, seqlnJobStatusRaw } from './seqln.js';

const FAILED_BODY = {
  ok: false, job_id: 'j1', status: 'failed',
  error: 'bridged take not settled', detail: 'payer bridge needs hash_h',
};

function serve(body, { httpStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: httpStatus >= 200 && httpStatus < 300, status: httpStatus,
             text: async () => JSON.stringify(body) };
  };
  return calls;
}

test('the plain read still THROWS on a failed job — commands must keep failing loudly', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  serve(FAILED_BODY);
  await assert.rejects(() => seqlnJobStatus('j1'), /not settled/);
});

test('THE BUG: the raw read RETURNS a failed job instead of throwing it away', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  serve(FAILED_BODY);
  const j = await seqlnJobStatusRaw('j1');
  assert.equal(j.status, 'failed', 'the reconciler can only act on what it can see');
  assert.equal(j.ok, false, 'ok:false is preserved, not laundered into a success');
  assert.match(j.error, /not settled/, 'and the reason survives for the user-facing detail');
});

test('a job still running reads back normally', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  serve({ ok: true, job_id: 'j1', status: 'running' });
  assert.equal((await seqlnJobStatusRaw('j1')).status, 'running');
});

test('a TRANSPORT failure still throws — it says nothing about the job', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  serve({ error: 'bad gateway' }, { httpStatus: 502 });   // no `status` field at all
  await assert.rejects(() => seqlnJobStatusRaw('j1'),
    'a 502 must not be mistaken for "the job is fine"');
});

test('an unparseable body throws rather than reconciling against garbage', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>nope' });
  await assert.rejects(() => seqlnJobStatusRaw('j1'));
});

test('it is ONE request, and it hits the same path as the plain read', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  const calls = serve(FAILED_BODY);
  await seqlnJobStatusRaw('j1');
  assert.equal(calls.length, 1, 'no retry-on-throw double fetch');
  assert.equal(calls[0].url, 'http://lsp/swap/j1');
  assert.ok(!('allowNotOk' in (calls[0].init || {})), 'the flag is ours, not fetch\'s');
});

test('a full path is passed through unchanged', async () => {
  initSeqln({ lspUrl: 'http://lsp' });
  const calls = serve({ ok: true, status: 'running' });
  await seqlnJobStatusRaw('/swap/abc');
  assert.equal(calls[0].url, 'http://lsp/swap/abc');
});

// ---------------------------------------------------------------------------
// THE RECORD THE RECONCILER WAS NOT EVEN LOOKING AT.
//
// The stall that prompted this was a BRIDGE record stuck in 'confirming'. The
// reconciler read SUBSWAP and nothing else — and 'confirming' is not a subswap
// state at all, so for the rail that actually got stuck it was inspecting the
// wrong object and would have found nothing however well it read the job.
//
// Two independent defects had to line up to produce the reported behaviour, and
// each alone was enough to cause it:
//   - the failed job could not be READ (ok:false threw), and
//   - the failed record was not being LOOKED AT (SUBSWAP only).
// ---------------------------------------------------------------------------
import { initSwap, __test__ as SW } from './swap.js';

const FAILED = { ok: false, job_id: 'j-bridge', status: 'failed', error: 'bridged take not settled' };

function wallet({ jobs = FAILED } = {}) {
  initSwap({
    assetMeta: () => ({ ticker: 'USDX', precision: 8 }),
    fmtAtoms: String, $: () => null, el: () => null,
    balObj: () => ({}), feeRates: {},
    ln: { jobStatusRaw: async () => jobs },
  });
  SW.setSubswapRecord(null);
  SW.setBridgeRecord(null);
}

const bridgeRec = (over = {}) => ({ state: 'confirming', job_id: 'j-bridge',
  poll: '/swap/j-bridge', asset: 'aa', ...over });

test('THE REPORTED STALL: a bridge in confirming whose job failed marks itself failed', async () => {
  wallet();
  SW.setBridgeRecord(bridgeRec());
  await SW.reconcileJobStatus(true);
  const b = SW.bridgeRecord();
  assert.equal(b.state, 'failed', 'this is what left the wallet refusing every later trade');
  assert.match(b.detail, /your funds are safe/);
  assert.match(b.detail, /not settled/, 'the LSP reason is carried through, not discarded');
});

test('a bridge job that is still running is left strictly alone', async () => {
  wallet({ jobs: { ok: true, job_id: 'j-bridge', status: 'running' } });
  SW.setBridgeRecord(bridgeRec());
  await SW.reconcileJobStatus(true);
  assert.equal(SW.bridgeRecord().state, 'confirming');
});

test('PAST COMMITMENT the reconciler must NOT touch the record', async () => {
  // Beyond 'confirming' the taker has minted a hold / funded an asset leg, and the
  // running driver owns it. Marking that dead behind the driver's back would call a
  // trade lost while value is still in flight.
  for (const over of [{ state: 'fronted' }, { state: 'relaying' }, { state: 'asset_funded' },
                      { state: 'confirming', fronted: true },
                      { state: 'confirming', seq_redeem: '51ab' },
                      { state: 'confirming', hold_settled: true }]) {
    wallet();
    SW.setBridgeRecord(bridgeRec(over));
    await SW.reconcileJobStatus(true);
    assert.notEqual(SW.bridgeRecord().state, 'failed',
      `a committed bridge (${JSON.stringify(over)}) must never be auto-failed`);
  }
});

test('bridgePreCommitment names exactly the safe window', () => {
  assert.equal(SW.bridgePreCommitment({ state: 'starting' }), true);
  assert.equal(SW.bridgePreCommitment({ state: 'confirming' }), true);
  assert.equal(SW.bridgePreCommitment({ state: 'fronted' }), false);
  assert.equal(SW.bridgePreCommitment({ state: 'settled' }), false);
  assert.equal(SW.bridgePreCommitment(null), false);
});

test('a subswap still reconciles — covering the bridge did not displace it', async () => {
  wallet({ jobs: { ok: false, job_id: 'j-sub', status: 'failed', error: 'nope' } });
  SW.setSubswapRecord({ state: 'paying', kind: 'lsp-payer-buy', job_id: 'j-sub', poll: '/swap/j-sub' });
  await SW.reconcileJobStatus(true);
  assert.equal(SW.subswapRecord().state, 'failed');
});

test('SUBSWAP takes precedence, and a committed subswap is left to its driver', async () => {
  wallet({ jobs: { ok: false, job_id: 'j-sub', status: 'failed', error: 'nope' } });
  SW.setSubswapRecord({ state: 'claiming', kind: 'p2p-buy', job_id: 'j-sub', poll: '/swap/j-sub',
    preimage: 'ab'.repeat(32), leg: { txid: 'cd'.repeat(32) } });
  await SW.reconcileJobStatus(true);
  assert.equal(SW.subswapRecord().state, 'claiming', 'we hold P — the claim driver owns this');
});

test('a probe that THROWS leaves the record untouched rather than guessing', async () => {
  initSwap({
    assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: String,
    $: () => null, el: () => null, balObj: () => ({}), feeRates: {},
    ln: { jobStatusRaw: async () => { throw new Error('502 bad gateway'); } },
  });
  SW.setSubswapRecord(null);
  SW.setBridgeRecord(bridgeRec());
  await SW.reconcileJobStatus(true);
  assert.equal(SW.bridgeRecord().state, 'confirming', 'a transport error is not evidence of failure');
});

test('with no job-status capability wired at all, nothing is invented', async () => {
  initSwap({
    assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: String,
    $: () => null, el: () => null, balObj: () => ({}), feeRates: {},
  });
  SW.setSubswapRecord(null);
  SW.setBridgeRecord(bridgeRec());
  await SW.reconcileJobStatus(true);
  assert.equal(SW.bridgeRecord().state, 'confirming');
});
