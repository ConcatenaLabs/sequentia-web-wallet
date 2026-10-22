// An offer is taken for what it still rests at: the relay's active_amount from the book's statuses,
// not its signed amounts. After a part fill the next market order reaching that offer asked for its
// signed size and the relay refused it ("take_amount exceeds active_amount").
//
//   node --test swap-active-size.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as seqob from './seqob.js';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}', i) + 2); };
const big = (v) => BigInt(v || 0);

// The live testnet ask after two fills: signed 141.20817427 tSEQ for 50.1 USDX, 84.8376 left.
const ask = { offer_id: 'd204b9fa', maker_pubkey: '03ADDA47', base_amount: '14120817427', offer_amount: '14120817427', want_amount: '5010000000' };
const bid = { offer_id: '0194df08', maker_pubkey: '021532a9', base_amount: '14120817427', offer_amount: '4990000000', want_amount: '14120817427' };

test('the book statuses set what an offer can still be filled for, never above what it signed', () => {
  const { noteActive } = seqob.__test__;
  assert.equal(seqob.offerActive(ask), 14120817427n, 'unknown: its signed size');
  noteActive({ offer_id: 'd204b9fa', maker_pubkey: '03adda47', active_amount: '8483760000' });
  assert.equal(seqob.offerActive(ask), 8483760000n);
  noteActive({ offer_id: '0194df08', maker_pubkey: '021532a9', active_amount: '99999999999' });
  assert.equal(seqob.offerActive(bid), 14120817427n, 'capped at the signed base');
  const fb = readFileSync(new URL('./seqob.js', import.meta.url), 'utf8');
  assert.match(fb, /for \(const st of \(j\.statuses \|\| j\.Statuses \|\| \[\]\)\) noteActive\(st\);/, 'fetchBook keeps the statuses');
  assert.match(fb, /if \(status\) noteActive\(status\);/, 'and the live book its deltas');
});

test('both legs scale to what rests, in the offer\'s own terms', () => {
  const offerRests = new Function('big', 'seqob', 'return ' + fn('offerRests'))(big, seqob);
  const a = offerRests(ask);
  assert.equal(a.act, 8483760000n);
  assert.equal(a.recv, 8483760000n, 'an ask gives its base: exactly what rests');
  assert.equal(a.pay, 5010000000n * 8483760000n / 14120817427n);
  seqob.__test__.noteActive({ offer_id: '0194df08', maker_pubkey: '021532a9', active_amount: '7060408713' });
  const b = offerRests(bid);
  assert.equal(b.pay, 7060408713n, 'a bid wants its base: exactly what rests');
  assert.equal(b.recv, 4990000000n * 7060408713n / 14120817427n);
});

test('every take is sized from what rests', () => {
  assert.match(fn('executableQuote'), /const most = offerRests\(o\)\.act;\s*if \(take > most\) take = most;/);
  assert.match(fn('executableQuote'), /capped: take >= most \};/);
  assert.match(fn('walkPreview'), /const \{ recv: oRecv, pay: oPay \} = offerRests\(o\);/);
  const walk = src.slice(src.indexOf('export async function takeMarketWalk('), src.indexOf('async function takeCovenantWalkReview('));
  assert.match(walk, /const \{ recv: oRecv, pay: oPay \} = offerRests\(o\);/);
  assert.ok(!/const oRecv = big\(o\.offer_amount/.test(walk), 'no take sized from the signed amount');
});
