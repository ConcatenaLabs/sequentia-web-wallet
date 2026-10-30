// Help in default mode says none of the words default mode never says (docs/DEFAULT_MODE.md):
// what names a rail sits in a .dev-only card. And the footer shows the page's version, which
// every problem report carries.
//   node --test help-default-words.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { forbiddenIn, USER_MODE_FORBIDDEN_WORDS } from './user-trade.js'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

test('node is on the list', () => {
  assert.ok(USER_MODE_FORBIDDEN_WORDS.includes('node'))
  assert.ok(USER_MODE_FORBIDDEN_WORDS.includes('nodes'))
})

test('Help, as default mode shows it, says none of the forbidden words', () => {
  const start = html.indexOf('<section data-panel="help"')
  let help = html.slice(start, html.indexOf('</section>', start))
  // Each .dev-only card is hidden in default mode; it runs to the next card or the end.
  help = help.replace(/<div class="card faq dev-only">[\s\S]*?(?=<div class="card|$)/g, '')
  const text = help.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
  assert.deepEqual(forbiddenIn(text), [])
  assert.match(html, /<div class="card faq dev-only">\s*<label class="lbl">Lightning<\/label>/)
})

test('the footer shows the version every report carries', () => {
  assert.match(html, /<span id="pageVersion"><\/span>/)
  assert.match(html, /const v = pageVersion\(\), e = \$\('pageVersion'\); if \(e && v\) e\.textContent = ' · Version ' \+ v;/)
  assert.match(html, /wallet: 'web-wallet', version: pageVersion\(\) \|\| 'unknown'/)
})
