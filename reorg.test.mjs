// A scan refused because the chain went back below the wallet's height is told apart from any
// other sync failure, and the page rebuilds the wallet's state on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isStaleTipError } from './reorg.js';

test("SWK's refusal of an update below the wallet's height is a reorg", () => {
  assert.equal(isStaleTipError(new Error('Update height 195096 too old (internal height 195114)')), true);
  assert.equal(isStaleTipError('update height 1 too old (internal height 2)'), true);
  assert.equal(isStaleTipError(new Error('Update created on a wallet with status X while current wallet has Y')), false);
  assert.equal(isStaleTipError(new Error('Failed to fetch')), false);
  assert.equal(isStaleTipError(null), false);
});

test('the page rebuilds the wallet and its cache on it, both wallets', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /async function rebuildAfterReorg\(e\)\{/);
  assert.match(html, /if\(!isStaleTipError\(e\)\) throw e;/, 'the primary scan rebuilds on a reorg, and only then');
  assert.match(html, /isStaleTipError\(e\)\) resetCompanion\(\)/, 'the companion is dropped and scanned again next sync');
});
