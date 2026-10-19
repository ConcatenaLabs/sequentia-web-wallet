// Room to receive the service cannot open: the wallet says why, and a fee it already paid is kept
// and can buy a smaller room now.
//
//   node --test room-stock.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('the refusals of a short service are recognised, from the LP and from the LSP', () => {
  const roomShortfall = new Function('return ' + fn('roomShortfall'))();
  assert.ok(roomShortfall(new Error('fundchannel: Could not afford 230005000sat using all 7 available UTXOs: 134113132sat short')));
  assert.ok(roomShortfall(Object.assign(new Error('the service can open at most 83386956 atoms of room to receive in OILX right now'), { status: 409 })));
  assert.ok(roomShortfall(new Error('the service holds no OILX to open room to receive right now')));
  assert.ok(!roomShortfall(Object.assign(new Error('that fee payment already paid for another purchase'), { status: 409 })));
  assert.ok(!roomShortfall(new Error('timed out')));
});

test('the dialog says what the service can open, and what happened to the fee', () => {
  const dlg = fn('lnReceiveRoomDialog');
  assert.match(dlg, /q\.stock_max!=null \? roomStockText/);
  assert.match(dlg, /Your fee is paid and kept: the wallet asks again each time it opens/);
  assert.match(dlg, /Nothing was paid\./);
});

test('a paid fee buys a smaller room without paying again', () => {
  const dlg = fn('lnReceiveRoomDialog');
  assert.match(dlg, /atoms<=BigInt\(paid\.amount\)/, 'no more room than it paid for (feeReuseProblem)');
  assert.match(dlg, /if\(!last\.paid\) lnRoomSlotFree\(\);/);
  const reuse = dlg.slice(dlg.indexOf('if(last.paid){'));
  assert.ok(reuse.indexOf('lnClaimInbound(') < reuse.indexOf('lnSendDeposit('), 'the reuse claims before any payment path');
  assert.match(fn('lnPaidRoom'), /p\.fee_txid && p\.asset===asset/);
});

test('the Move field names the stock too', () => {
  assert.match(fn('lnMoveRoomField'), /q\.stock_max!=null \? roomStockText/);
});
