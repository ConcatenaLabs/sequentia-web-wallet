// index.html is one big ES module. A helper it calls but never imports is a
// ReferenceError that only fires when that line runs — and most of the call
// sites sit inside a try/catch, so the failure is silent: the Lightning
// receive card once shipped for weeks with an empty asset picker because
// `esc` lived in swap.js and was never imported here.
//
// This checks the narrow, decidable case: a function defined at the top level
// of a sibling module, CALLED in index.html, and neither imported nor declared
// locally. No parser and no dependency — index.html is a static page with no
// build step, and this test keeps it that way.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script type="module">'), html.lastIndexOf('</script>'));
// Prose mentions a helper as often as code calls it, so drop comments and quoted
// strings before looking for calls. Template literals STAY: `${esc(x)}` is a call,
// and is exactly where the Lightning picker's missing import hid.
const mod = script
  .replace(/\/\*[\s\S]*?\*\//g, ' ')                 // block comments
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')             // line comments (not a URL's //)
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")                // single-quoted strings
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');              // double-quoted strings

// Names index.html brings into scope: imported, or declared anywhere in the module.
const bound = new Set();
for (const m of script.matchAll(/import\s+([^;]*?)\s+from\s+['"][^'"]+['"]/g)) {
  for (const n of m[1].replace(/[{}]/g, ' ').split(',')) {
    const name = n.trim().split(/\s+as\s+/).pop().trim();
    if (name && name !== '*') bound.add(name);
  }
}
for (const m of script.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) bound.add(m[1]);

// Top-level function names each sibling module defines.
const siblings = readdirSync(new URL('.', import.meta.url))
  .filter(f => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const defined = new Map();   // name -> file
for (const f of siblings) {
  const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!defined.has(m[1])) defined.set(m[1], f);
  }
}

test('index.html declares or imports every sibling-module helper it calls', () => {
  const missing = [];
  for (const [name, file] of defined) {
    if (bound.has(name)) continue;
    if (!new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(mod)) continue;
    missing.push(`${name}() is called in index.html but only defined in ${file}`);
  }
  assert.deepStrictEqual(missing, [], '\n' + missing.join('\n'));
});
