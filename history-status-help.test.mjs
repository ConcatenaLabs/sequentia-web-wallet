// History's status words open their answer in Help: each word names a question that is there, and
// the answers speak default mode's words (docs/DEFAULT_MODE.md), never USER_MODE_FORBIDDEN_WORDS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forbiddenIn } from './user-trade.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const map = html.slice(html.indexOf('const STATUS_HELP = {'), html.indexOf('};', html.indexOf('const STATUS_HELP = {')));
const card = html.slice(html.indexOf('<div class="card faq" id="faqHistory">'), html.indexOf('<!-- Lightning names a rail'));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

test('every status word opens a question that is in Help', () => {
  const ids = [...map.matchAll(/'(faq-[a-z-]+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 10, 'the words are mapped');
  for (const id of new Set(ids)) assert.match(html, new RegExp(`<details id="${id}">`), id);
});

test('the answers about History are shown in both modes and speak default mode\'s words', () => {
  assert.ok(card.length > 1000, 'the card is there');
  assert.doesNotMatch(card.slice(0, 80), /dev-only/);
  assert.deepEqual(forbiddenIn(text(card)), []);
});

test('the rows show their status words through statusHelp', () => {
  for (const site of [
    "statusHelp(null, a.kind==='coming_back' ? DEFAULT_WORDS.rowComingBack : DEFAULT_WORDS.rowArriving)",
    "statusHelp('sub unconf', DEFAULT_WORDS.rowArriving+' · '+DEFAULT_WORDS.arrivingSoon)",
    "statusHelp('kind','Dropped by the network",
    'mid.appendChild(statusHelp(null, head));',
    'else statusInto(d, t);',
  ]) assert.ok(html.includes(site), site);
  assert.equal(html.split("statusHelp('sub', SPEED_WORDS.spedUp)").length - 1, 2, 'both sped-up lines');
});
