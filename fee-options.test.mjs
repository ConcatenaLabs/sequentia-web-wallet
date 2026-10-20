// Send's fee: recommended by default, a custom rate only under Fee options, as in Sequentia Qt.
//
//   node --test fee-options.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('the rate field is behind Fee options, not on the Send form', () => {
  const send = html.slice(html.indexOf('<section data-panel="send"'), html.indexOf('id="btnReview"'));
  assert.match(send, /id="btnFeeOpts"/);
  const opts = send.slice(send.indexOf('id="feeOpts"'));
  assert.match(send, /<div id="feeOpts" class="fee-opts hide">/, 'closed by default');
  assert.ok(opts.indexOf('id="feeRate"') > 0, 'the rate field lives inside the options');
  assert.match(opts, /value="rec" checked/, 'recommended by default');
});

test('everything that builds or judges a send reads the chosen rate, never the field', () => {
  assert.equal((html.match(/\$\('feeRate'\)\.value/g) || []).length, 1, 'only feeUnitsChosen reads the field');
  assert.match(fn('feeUnitsChosen'), /_feeMode==='custom'/);
  assert.match(fn('btcFeeRate'), /feeUnitsChosen\(\)/);
  assert.match(fn('feeRateVerdict'), /feeUnitsChosen\(\)/);
  assert.match(fn('buildSendPset'), /const fr=feeUnitsChosen\(\);/);
});

test('a flood on testnet4 does not set the recommended bitcoin rate', () => {
  const r = fn('refreshFeeRec');
  assert.match(html, /const BTC_SANE_FEERATE = 50;/);
  const i = r.indexOf('v>BTC_SANE_FEERATE');
  assert.ok(i > 0 && !/units=/.test(r.slice(i, r.indexOf('else if(v>0)'))), 'over the sane rate, units stay null');
});

test('with no estimate the standard rate is used, above it only when the next block is full', () => {
  const r = fn('refreshFeeRec');
  assert.match(r, /\/estimatefee\?blocks='\+target\+'&asset='/);
  assert.match(r, /c\.next_block_full && nb>0/);
  assert.match(r, /Blocks have room now, so the standard rate confirms in the next block\./);
});
