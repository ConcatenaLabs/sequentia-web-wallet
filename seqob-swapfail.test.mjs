// A maker that cannot co-sign answers a sealed seqdex.v1.SwapFail at once (seqdex SealSwapFail).
// The wallet reads it as a refusal, stops, signs nothing and says the maker's reason, instead of
// waiting out its co-sign deadline (61 s) and saying "the other side did not answer in time".
//
//   node --test seqob-swapfail.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as seqob from './seqob.js';

const te = new TextEncoder();
const varint = (n) => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; };
const str = (field, s) => { const b = te.encode(s); return [...varint((field << 3) | 2), ...varint(b.length), ...b]; };
const num = (field, n) => [...varint((field << 3) | 0), ...varint(n)];
const { decodeSwapAccept } = seqob.__test__;

test('a SwapFail reads as a refusal with its reason', () => {
  const fail = Uint8Array.from([...str(1, 'f1'), ...num(3, 1), ...str(4, 'the maker cannot fund this lift right now')]);
  const r = decodeSwapAccept(fail);
  assert.equal(r.transaction, '');
  assert.equal(r.failure_code, 1);
  assert.equal(r.failure_message, 'the maker cannot fund this lift right now');
});

test('an accept still reads as an accept', () => {
  const acc = Uint8Array.from([...str(1, 'a1'), ...str(2, 'r1'), ...str(3, 'cHNldP8BAgME'), ...str(4, '\x0a\x02x')]);
  const r = decodeSwapAccept(acc);
  assert.deepEqual(r, { id: 'a1', request_id: 'r1', transaction: 'cHNldP8BAgME' });
});

test('the lift stops at the refusal and the page says why', () => {
  const src = readFileSync(new URL('./seqob.js', import.meta.url), 'utf8');
  assert.match(src, /if \(acc\.failure_message != null && !acc\.transaction\)\s*throw new Error\('maker refused: '/);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const i = html.indexOf('maker refused: (the maker cannot fund');
  assert.ok(i > 0 && i < html.indexOf("if(/maker did not answer: /.test(m))"), 'said before the no-answer line');
  assert.match(html, /return 'The other side declined: '\+r\[1\]\+'\. This wallet signed nothing, so nothing was traded\.';/);
});
