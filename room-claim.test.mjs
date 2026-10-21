// Room to receive, after the fee is paid: a fee the service finds too small is said with both amounts
// instead of waited on for eight minutes, its errors are said plainly instead of "Something went
// wrong", and the dialog can be closed while the purchase goes on (21/10/2026: none of the three).
//
//   node --test room-claim.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(html.lastIndexOf('\n', i) + 1, html.indexOf('\n}', i) + 2); };

const claim = (answers) => {
  const calls = [];
  const src = fn('lnClaimInbound').replace('async function lnClaimInbound', 'return async function');
  const run = new Function('seqlnChannelInbound', 'lnClearInbound', 'setTimeout', src)(
    async () => { calls.push(1); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    () => {}, (f) => f());
  return { run, calls };
};
const http = (status, body) => Object.assign(new Error(body.error || 'x'), { status, body });

test('a fee seen and too small stops at once, with both amounts', async () => {
  const { run, calls } = claim([http(402, { paid: 257333066, least: 272200422, error: 'the fee payment ab pays 257333066' })]);
  const e = await run({ node: 'n', asset: 'a', amount: 1, fee_txid: 'ab' }).catch((x) => x);
  assert.equal(calls.length, 1);
  assert.deepEqual(e.feeShort, { paid: 257333066n, least: 272200422n });
});

test('a fee not seen yet is waited on, then the room opens', async () => {
  const said = [];
  const { run, calls } = claim([http(402, { paid: 0 }), http(402, { paid: 0 }), { ok: true, channel_id: 'c' }]);
  const r = await run({ node: 'n', asset: 'a', amount: 1, fee_txid: 'ab' }, (t) => said.push(t));
  assert.equal(r.channel_id, 'c');
  assert.equal(calls.length, 3);
  assert.ok(said.some((t) => /Waiting for the service to see your fee payment/.test(t)));
});

test('the service errors read as sentences, with no txid in them', () => {
  const fmtAtoms = (a) => (Number(a) / 1e8).toString();
  const text = new Function('fmtAtoms', 'return ' + fn('lnRoomErrorText'))(fmtAtoms);
  assert.equal(text({ feeShort: { paid: 257333066n, least: 272200422n } }, 'tSEQ', 8),
    'The service sees your fee payment of 2.57333066 tSEQ, but it asks at least 2.72200422 tSEQ for this room.');
  assert.match(text(new Error('LP could not connect to the user node: timeout'), 'tSEQ', 8), /could not reach your tSEQ Lightning node/);
  assert.match(text(new Error('inbound channel did not reach CHANNELD_NORMAL in time'), 'tSEQ', 8), /not usable yet/);
  assert.equal(text(new Error('something else'), 'tSEQ', 8), null);
  // Both places that claim room use it before prettyErr.
  assert.equal((html.match(/\|\| lnRoomErrorText\(e, /g) || []).length, 2);
});

test('the dialog closes at any time, and the purchase goes on behind it', () => {
  const dlg = fn('lnReceiveRoomDialog');
  const click = dlg.slice(dlg.indexOf('ok.onclick=async()=>{'));
  assert.match(click, /no\.textContent='Close'; no\.onclick=\(\)=>\{ closed=true; m\.remove\(\); \};/);
  assert.ok(!/no\.disabled=true/.test(dlg), 'Close is never disabled');
  assert.match(click, /You can close this window: the purchase goes on, and a paid fee is kept\./);
  assert.match(click, /if\(closed\) toast\('Room to receive '\+tk\+': '/);
});
