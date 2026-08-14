// Supervision display: the registry index carries a flag at v[5], and the wallet
// must read it, badge it, and not badge anything else.
//
// The wallet is one static page with no build step, so the functions under test
// are extracted from the inline module rather than imported. That is the same
// approach the other suites here take.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const html = fs.readFileSync('/home/aejkohl/sequentia-web-wallet/index.html', 'utf8');

function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  // Walk braces to the end of the function.
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `${name} not terminated`);
  return html.slice(start, end);
}

const harness = `
  let POLICY_HEX = 'aa'.repeat(32);
  let REGISTRY_ASSETS = {};
  const made = [];
  function el(tag){ const o = {tag, style:{cssText:''}, setAttribute(){}, }; made.push(o); return o; }
  ${extract('assetSupervised')}
  ${extract('supervisionBadge')}
  return { set(r){ REGISTRY_ASSETS = r; }, assetSupervised, supervisionBadge, POLICY_HEX };
`;
const w = new Function(harness)();

const SUPERVISED = '11'.repeat(32);
const PLAIN = '22'.repeat(32);
w.set({
  [SUPERVISED]: { ticker: 'USDC.e', supervised: true, verified: true },
  [PLAIN]: { ticker: 'GOLD', supervised: false, verified: true },
});

test('a supervised asset is recognised from the registry flag', () => {
  assert.equal(w.assetSupervised(SUPERVISED), true);
  assert.ok(w.supervisionBadge(SUPERVISED));
});

test('an ordinary asset is not badged', () => {
  assert.equal(w.assetSupervised(PLAIN), false);
  assert.equal(w.supervisionBadge(PLAIN), null);
});

test('an asset the registry has never heard of is not badged', () => {
  // Absence of evidence, not evidence of absence: an unknown id already gets
  // the unregistered warning from trustBadge, and claiming it is unsupervised
  // would be a statement the wallet cannot support.
  assert.equal(w.assetSupervised('33'.repeat(32)), false);
  assert.equal(w.supervisionBadge('33'.repeat(32)), null);
});

test('the native units are never supervised', () => {
  assert.equal(w.assetSupervised(w.POLICY_HEX), false);
  assert.equal(w.assetSupervised('BTC'), false);
  assert.equal(w.assetSupervised(''), false);
  assert.equal(w.assetSupervised(null), false);
});

test('the badge explains what a freeze can and cannot reach', () => {
  const b = w.supervisionBadge(SUPERVISED);
  assert.match(b.title, /freeze/i);
  assert.match(b.title, /Lightning/i);
  assert.match(b.title, /never spend your coins/i);
  assert.match(b.title, /cannot be added or removed later/i);
});
