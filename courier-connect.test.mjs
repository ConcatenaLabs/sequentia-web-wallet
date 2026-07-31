// A COURIER CONNECT THAT NEVER COMPLETES MUST FAIL, NOT HANG.
//
// openCourierSession awaited ws.onopen / ws.onerror with no deadline. onerror fires for a REFUSED
// connection, but a socket that simply never finishes its handshake — a stalled proxy hop, a relay
// that accepted the TCP and went quiet — leaves that promise pending forever, and with it the take.
//
// That is exactly how it looked in the wallet: the cross stepper frozen on its first step, no session
// ever appearing in the relay log, no error anywhere, indefinitely. A take must FAIL so the caller can
// try the next offer; hanging is the one outcome nothing recovers from.
//
//   node --test courier-connect.test.mjs
import assert from 'node:assert';
import test from 'node:test';

const OPEN_TIMEOUT_MS = 12000;

// The connect handshake from xcourier.js, with an injectable timer.
function connect(ws, { setTimer, clearTimer }) {
  const transportOnClose = ws.onclose;
  return new Promise((resolve, reject) => {
    const timer = setTimer(() => {
      try { ws.close(); } catch {}
      reject(new Error('the order-book relay did not answer in time'));
    }, OPEN_TIMEOUT_MS);
    const done = (fn) => (...a) => { clearTimer(timer); ws.onclose = transportOnClose; fn(...a); };
    ws.onopen = done(resolve);
    ws.onerror = done(() => reject(new Error('could not reach the order-book relay')));
    ws.onclose = done(() => reject(new Error('the order-book relay closed the connection')));
  });
}

const mkWs = () => ({ onopen: null, onerror: null, onclose: 'TRANSPORT_HANDLER', closed: false, close(){ this.closed = true; } });
const mkTimers = () => {
  let fire = null;
  return { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { fire = null; }, run: () => fire && fire(), pending: () => !!fire };
};

test('THE HANG: a socket that never answers rejects on the deadline', async () => {
  const ws = mkWs(), T = mkTimers();
  const p = connect(ws, T);
  T.run();                                   // the deadline elapses; nothing ever opened
  await assert.rejects(p, /did not answer in time/);
  assert.equal(ws.closed, true, 'and the dead socket is closed rather than leaked');
});

test('a successful open resolves and cancels the deadline', async () => {
  const ws = mkWs(), T = mkTimers();
  const p = connect(ws, T);
  ws.onopen();
  await p;
  assert.equal(T.pending(), false, 'a fired timer would later reject an already-open session');
});

test('a close BEFORE open is reported at once, not waited out', async () => {
  const ws = mkWs(), T = mkTimers();
  const p = connect(ws, T);
  ws.onclose();
  await assert.rejects(p, /closed the connection/);
});

test("the transport's own onclose handler is given back, never cleared", async () => {
  // wsTransport installs the handler that fails in-flight waiters when the relay drops. Clearing it
  // would leave a live session unable to notice the relay going away — a different silent hang.
  for (const trigger of ['open', 'error', 'close']) {
    const ws = mkWs(), T = mkTimers();
    const p = connect(ws, T).catch(() => {});
    if (trigger === 'open') ws.onopen(); else if (trigger === 'error') ws.onerror(); else ws.onclose();
    await p;
    assert.equal(ws.onclose, 'TRANSPORT_HANDLER', `onclose not restored after ${trigger}`);
  }
});

test('a refused connection still reports refusal, not a timeout', async () => {
  const ws = mkWs(), T = mkTimers();
  const p = connect(ws, T);
  ws.onerror();
  await assert.rejects(p, /could not reach/);
});
