// Receiving over Lightning counts only room that is ready. Room on a channel still opening is said
// as "ready in about a minute", and no invoice is made against it: nobody could pay that invoice.
//
//   node --test ln-receive-ready.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

const ASSET = 'aa'.repeat(32);
// The channels of a wallet that has just moved USDX to Lightning: its own channel is ready, the room
// it bought in the same step is still opening (both as the service's /status reports them).
const opening = { channels: [
  { node_key: 'n', state: 'CHANNELD_NORMAL', asset: ASSET, receivable_units: 100000000 },
  { node_key: 'n', state: 'CHANNELD_AWAITING_LOCKIN', asset: ASSET, receivable_units: 5392487622 },
  { state: 'CHANNELD_NORMAL', asset: ASSET, receivable_units: 7 },   // not this wallet's
] };
const ready = { channels: opening.channels.map((c) => ({ ...c, state: 'CHANNELD_NORMAL' })) };
const make = (name, status) => new Function('lnLastStatus', 'lnChannelAsset', 'return ' + fn(name))(status, (c) => c.asset);

test('room on a channel still opening is not room to receive', () => {
  assert.equal(make('lnReceivableFor', opening)(ASSET), 100000000n);
  assert.equal(make('lnReceivableFor', ready)(ASSET), 100000000n + 5392487622n);
});

test('room on its way is known as such', () => {
  assert.equal(make('lnReceiveOpeningFor', opening)(ASSET), true);
  assert.equal(make('lnReceiveOpeningFor', ready)(ASSET), false);
  assert.equal(make('lnReceiveOpeningFor', { channels: [{ node_key: 'n', state: 'CHANNELD_AWAITING_LOCKIN', asset: ASSET, receivable_units: 0 }] })(ASSET), false,
    'a channel the wallet funded alone, opening, brings no room');
});

// The Receive card's line under the asset picker, painted for a status.
function paint (status) {
  const box = { textContent: '', innerHTML: '', appendChild () {} };
  const scheduled = [];
  const paintFn = new Function('lnLastStatus', 'lnChannelAsset', '$', 'assetMeta', 'fmtAtoms', 'fmtAmount', 'devMode', 'lnRecheckRoomSoon', 'el', 'lnOnLightning', 'lnReceiveRoomDialog', 'lnLegFor', 'state',
    'let _lnRoomRechecks = 0;' + fn('lnReceivableFor') + fn('lnReceiveOpeningFor') + 'return ' + fn('lnPaintRecvRoom'))(
    status, (c) => c.asset,
    (id) => (id === 'lnRecvRoom' ? box : { value: ASSET }),
    () => ({ ticker: 'USDX', precision: 8 }),
    (a, d) => (Number(a) / 10 ** d).toString(),
    (a, d) => (Number(a) / 10 ** d).toString(),
    () => false,
    () => scheduled.push(1),
    () => ({}), () => true, () => {}, () => ({}));
  paintFn();
  return { text: box.textContent, rechecks: scheduled.length };
}

test('the Receive card says when room is on its way, and checks again by itself', () => {
  const onlyOpening = { channels: [opening.channels[1]] };
  assert.deepEqual(paint(onlyOpening), { text: 'Ready to receive USDX over Lightning in about a minute.', rechecks: 1 });
  assert.deepEqual(paint(opening), { text: 'You can receive up to 1 USDX over Lightning. More is ready to receive in about a minute.', rechecks: 1 });
  assert.deepEqual(paint(ready), { text: 'You can receive up to 54.92487622 USDX over Lightning.', rechecks: 0 });
});

test('no invoice is made for more than the ready room', () => {
  const i = html.indexOf('if (recvBtn) recvBtn.onclick');
  const handler = html.slice(i, html.indexOf('if (copyBtn)', i));
  const guard = handler.indexOf('room < BigInt(amt)'), node = handler.indexOf('lnConnectLeg(');
  assert.ok(guard > 0 && node > guard, 'the room check comes before the node is asked for an invoice');
  assert.match(handler, /if \(lnReceiveOpeningFor\(asset\)\)\s*st\.textContent = room > 0n \? 'You can receive up to '/);
  assert.match(handler, /'Ready to receive ' \+ meta\.ticker \+ ' over Lightning ' \+ when \+ '\. Make the invoice then\.'/);
  // A BTC channel is ready once a Bitcoin block confirms it, not in a minute.
  assert.match(handler, /const when = asset === 'BTC' \? 'once a Bitcoin block confirms it' : 'in about a minute';/);
});
