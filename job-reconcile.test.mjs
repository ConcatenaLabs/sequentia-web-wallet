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
