// One direction per pair on every surface: the wallet's canonicalPair. SeqDEX's site
// (seqdex-web shared/market-book.js, QUOTE_RANK) and Ambra rank the quotes the same.
import test from 'node:test';
import assert from 'node:assert';

globalThis.document = { activeElement: null };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };

const id = (n) => n.toString(16).padStart(2, '0').repeat(32);
const T = { [id(1)]: 'USDC.e', [id(2)]: 'EURC.e', [id(3)]: 'USDX', [id(4)]: 'EURX', [id(5)]: 'tSEQ', [id(6)]: 'GOLD', [id(7)]: 'OILX' };
const swap = await import('./swap.js');
// canonicalPair reads only the context's assetMeta, which initSwap sets first; the
// rest of initSwap wires the Trade tab's page, which this test has none of.
try { swap.initSwap({ assetMeta: (h) => ({ ticker: T[h] || '?', precision: 8 }) }); } catch { /* the page's wiring */ }
const dir = (a, b) => { const p = swap.canonicalPair(a, b); return (T[p.base] || p.base) + '/' + (T[p.quote] || p.quote); };

test('BTC, then the fiat stablecoins, are the quote; the bridged ones too', () => {
  assert.equal(dir(id(6), 'BTC'), 'GOLD/BTC');
  assert.equal(dir(id(3), 'BTC'), 'USDX/BTC');
  assert.equal(dir(id(5), id(3)), 'tSEQ/USDX');
  assert.equal(dir(id(5), id(1)), 'tSEQ/USDC.e');
  assert.equal(dir(id(1), id(5)), 'tSEQ/USDC.e');
  assert.equal(dir(id(6), id(2)), 'GOLD/EURC.e');
  assert.equal(dir(id(1), id(3)), 'USDC.e/USDX');
  assert.equal(dir(id(1), id(4)), 'USDC.e/EURX');
  assert.equal(dir(id(2), id(4)), 'EURC.e/EURX');
});

test('between two other assets the lower id is the base, the Sequence token included', () => {
  assert.equal(dir(id(7), id(5)), 'tSEQ/OILX');
  assert.equal(dir(id(6), id(7)), 'GOLD/OILX');
});

// docs/DEFAULT_MODE.md, Market: a pair is read as people price it. BTC against a fiat stablecoin
// is priced in the stablecoin; against anything else BTC stays the quote. Books keep canonicalPair.
test('BTC is read in a fiat stablecoin, and is the quote against everything else', () => {
  const show = (a, b) => { const p = swap.displayPair(a, b); return (T[p.base] || p.base) + '/' + (T[p.quote] || p.quote); };
  assert.equal(show(id(3), 'BTC'), 'BTC/USDX');
  assert.equal(show('BTC', id(3)), 'BTC/USDX');
  assert.equal(show('BTC', id(4)), 'BTC/EURX');
  assert.equal(show(id(1), 'BTC'), 'BTC/USDC.e');
  assert.equal(show(id(6), 'BTC'), 'GOLD/BTC');
  assert.equal(show('BTC', id(5)), 'tSEQ/BTC');
  assert.equal(show(id(5), id(3)), 'tSEQ/USDX', 'a pair without BTC reads as canonicalPair has it');
  assert.equal(dir(id(3), 'BTC'), 'USDX/BTC', 'the book key does not move');
});
