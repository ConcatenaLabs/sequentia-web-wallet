// Room to receive the service cannot open: the wallet says why, in the asset, and a fee it already
// paid is kept and can buy a smaller room now.
//
//   node --test room-stock.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('the dialog and the Move field say what the service can open', () => {
  assert.match(fn('lnReceiveRoomDialog'), /lnRoomShortText\(q, tk, prec\)/);
  assert.match(fn('lnMoveRoomField'), /lnRoomShortText\(q, tk, prec\)/);
});

test('a failed purchase says what happened to the fee', () => {
  const dlg = fn('lnReceiveRoomDialog');
  assert.match(dlg, /Your fee is paid and kept: the wallet asks again each time it opens/);
  assert.match(dlg, /Nothing was paid\./);
});

test('a paid fee buys a smaller room without paying again', () => {
  const dlg = fn('lnReceiveRoomDialog');
  assert.match(dlg, /atoms<=BigInt\(paid\.amount\) && \(q\.ok \|\| \(q\.lp_short && atoms<=BigInt\(q\.fundable\|\|0\)\)\)/, 'no more room than it paid for (feeReuseProblem), nor than the LP can fund');
  assert.match(dlg, /if\(!last\.paid\) lnRoomSlotFree\(\);/);
  const reuse = dlg.slice(dlg.indexOf('if(last.paid){'));
  assert.ok(reuse.indexOf('lnClaimInbound(') < reuse.indexOf('lnSendDeposit('), 'the reuse claims before any payment path');
  assert.match(fn('lnPaidRoom'), /p\.fee_txid && p\.asset===asset/);
});

test('the shortfall is said in the asset, from the new service and from an older one', () => {
  const fmtAtoms = (a, p) => (Number(a) / 10 ** p).toString();
  const lnRoomShortText = new Function('fmtAtoms', 'return ' + fn('lnRoomShortText'))(fmtAtoms);
  assert.equal(lnRoomShortText({ ok: false, lp_short: true, fundable: 83_386_956 }, 'OILX', 8),
    'The service does not hold enough OILX to open that room to receive right now; it can open at most 0.83386956 OILX.');
  assert.match(lnRoomShortText({ body: { lp_short: true, fundable: 0 } }, 'OILX', 8), /right now\.$/);
  // The raw refusal of an LP before the stock check: its "sat" are the asset's atoms.
  assert.equal(lnRoomShortText(new Error('fundchannel: Could not afford 230005000sat using all 7 available UTXOs: 134113132sat short'), 'OILX', 8),
    'The service does not hold enough OILX to open that room to receive right now: the channel needs 2.30005 OILX and it is 1.34113132 OILX short.');
  assert.equal(lnRoomShortText(new Error('timed out'), 'OILX', 8), null);
});

test('a fee the service knows was paid and never used is used, from any browser', () => {
  assert.match(fn('lnWaitingFee'), /BigInt\(atoms\) <= BigInt\(w\.amount\|\|0\)/);
  for (const name of ['lnReceiveRoomDialog', 'lnMoveToLightning']) {
    const i = html.indexOf('lnWaitingFee(q,', name === 'lnReceiveRoomDialog' ? html.indexOf('function lnReceiveRoomDialog(') : html.indexOf('Pricing the room to receive'));
    assert.ok(i > 0, name);
    assert.match(html.slice(i, i + 400), /const due=waiting \? 0n : BigInt\(q\.due_now\|\|0\);/);
  }
  const src = readFileSync(new URL('./tooling/lsp/lsp-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /paid_waiting: paidWaiting,/);
  assert.match(src, /if \(mode === 'prepaid' && body\.fee_txid\) markFeeOpened\(/);
  assert.match(src, /if \(prior && prior\.opened_at\) return send\(res, 200, \{ ok: true, already_opened: true/);
});
