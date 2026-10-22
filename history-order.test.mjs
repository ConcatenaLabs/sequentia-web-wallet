// History shows Bitcoin's card, then Sequentia's, then Lightning's, always in that order, and with
// none on either chain shows one line.
//
//   node --test history-order.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

// A minimal DOM: the panel's cards, their hidden state and their order.
function dom(){
  const cards = ['histEmptyCard', 'btcHistCard', 'seqHistCard', 'oampHistCard'].map((id) => ({ id, hidden: id === 'histEmptyCard', classList: null }));
  const panel = { kids: cards.slice(), insertBefore(a, b){ this.kids.splice(this.kids.indexOf(a), 1); this.kids.splice(this.kids.indexOf(b), 0, a); } };
  for (const c of cards){
    c.classList = { toggle: (cls, on) => { c.hidden = !!on; }, contains: () => c.hidden };
    Object.defineProperty(c, 'nextElementSibling', { get: () => panel.kids[panel.kids.indexOf(c) + 1] || null });
  }
  const byId = { historyPanel: panel, ...Object.fromEntries(cards.map((c) => [c.id, c])) };
  return { $: (id) => byId[id], shown: () => panel.kids.filter((c) => !c.hidden).map((c) => c.id) };
}
const run = (counts) => { const d = dom(); new Function('$', '_histCounts', fn('arrangeHistory') + 'arrangeHistory();')(d.$, counts); return d.shown(); };

test('Bitcoin, then Sequentia, then Lightning, in the markup and never reordered', () => {
  const at = (id) => html.indexOf('id="' + id + '"');
  assert.ok(at('btcHistCard') < at('seqHistCard') && at('seqHistCard') < at('lnHistCard') && at('lnHistCard') < at('oampHistCard'));
  assert.ok(!/insertBefore/.test(fn('arrangeHistory')));
  assert.deepEqual(run({ seq: 3, btc: 1, oamp: 0 }), ['btcHistCard', 'seqHistCard']);
  assert.deepEqual(run({ seq: 3, btc: 0, oamp: 0 }), ['btcHistCard', 'seqHistCard']);
  assert.deepEqual(run({ seq: 0, btc: null, oamp: 0 }), ['btcHistCard', 'seqHistCard'], 'an unread history is not called empty');
});

test('one line when neither chain has any', () => {
  assert.deepEqual(run({ seq: 0, btc: 0, oamp: 0 }), ['histEmptyCard']);
  assert.deepEqual(run({ seq: 0, btc: 0, oamp: 1 }), ['btcHistCard', 'seqHistCard', 'oampHistCard']);
});
