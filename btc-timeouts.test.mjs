// A trade with bitcoin checks each timeout against its own chain. Comparing a testnet4 height with
// a Sequentia height refused every on-chain BTC trade once Sequentia's height passed testnet4's.
//
//   node --test btc-timeouts.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const xswap = readFileSync(new URL('./xswap.js', import.meta.url), 'utf8');
const xrswap = readFileSync(new URL('./xrswap.js', import.meta.url), 'utf8');
const fn = (s, name) => { const i = s.indexOf('function ' + name + '('); assert.ok(i > 0, name); return s.slice(i, s.indexOf('\n', s.indexOf('{', i)) + 1).includes('}') ? s.slice(i, s.indexOf('\n', i) + 1) : s.slice(i, s.indexOf('\n}', i) + 2); };

// The terms two makers sent on 20/10/2026: testnet4 tip 157152, Sequentia tip 178883.
const LIVE = { bl: 157412, sl: 179123, btcTip: 157152, seqTip: 178883 };

test('no timeout is compared across the two chains', () => {
  for (const [name, s] of [['xswap.js', xswap], ['xrswap.js', xrswap]]) {
    assert.ok(!/\(bl > sl\)|btc_locktime > SWAP\.seq_locktime|T_btc must exceed T_seq/.test(s), name);
  }
});

test('a buy accepts the live terms: each timeout within its own chain bounds', () => {
  const MAX_BTC_LOCK_DELTA = 400, MIN_SEQ_CLAIM_WINDOW = 120;
  assert.match(xswap, new RegExp('const MAX_BTC_LOCK_DELTA = ' + MAX_BTC_LOCK_DELTA + ';'));
  assert.match(xswap, new RegExp('const MIN_SEQ_CLAIM_WINDOW = ' + MIN_SEQ_CLAIM_WINDOW + ';'));
  assert.match(xswap, /if \(!\(bl > btcTip && bl <= btcTip \+ MAX_BTC_LOCK_DELTA\)\)/);
  assert.match(xswap, /if \(!\(sl >= seqNow \+ MIN_SEQ_CLAIM_WINDOW\)\)/);
  const { bl, sl, btcTip, seqTip } = LIVE;
  assert.ok(bl > btcTip && bl <= btcTip + MAX_BTC_LOCK_DELTA);
  assert.ok(sl >= seqTip + MIN_SEQ_CLAIM_WINDOW);
  assert.ok(!(bl > sl), 'the old rule would have refused these terms');
});

test('a sale accepts them too, the bitcoin time outlasting the Sequentia time', () => {
  const reverseMinBtcDelta = new Function('BTC_CLAIM_MARGIN', 'return ' + fn(xrswap, 'reverseMinBtcDelta'))(6);
  assert.equal(reverseMinBtcDelta(240), 150);   // ceil(240 * 90 / 150) + 6, as xdriver_reverse.go
  assert.equal(reverseMinBtcDelta(400), 246);
  const { bl, sl, btcTip, seqTip } = LIVE;
  assert.ok(bl - btcTip >= reverseMinBtcDelta(sl - seqTip));
  assert.match(xrswap, /if \(tBtc - btcTip < reverseMinBtcDelta\(tSeq - seqTip\)\)/);
});

test('a failed handshake stays on screen until it is closed', () => {
  assert.match(xswap, /if \(msg\) \{ if \(C\.notice\) C\.notice\(msg\);/);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/notice: \(msg\) => swapNotice\(msg\),/g) || []).length, 2);
  assert.match(html, /function swapNotice\(msg\)\{/);
});

test('an error page from the testnet4 API is not read as height 0', () => {
  assert.ok(xswap.includes("const t = r.ok ? (await r.text()).trim() : '';"));
  assert.ok(xswap.includes(String.raw`if (/^\d+$/.test(t)) return Number(t);`));
});
