// index.html is one big ES module. A helper it calls but never imports is a
// ReferenceError that only fires when that line runs — and most of the call
// sites sit inside a try/catch, so the failure is silent: the Lightning
// receive card once shipped for weeks with an empty asset picker because
// `esc` lived in swap.js and was never imported here.
//
// This checks the narrow, decidable case: a name defined at the top level of a
// sibling module, USED in index.html, and neither imported nor declared locally.
// Functions AND variables: the Lightning cards also called swap.js's own `L`,
// a module-scoped `let`, so every invoice died on "L is not defined" — the same
// failure as `esc`, one binding kind further along. No parser and no dependency:
// index.html is a static page with no build step, and this test keeps it that way.
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
for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
// Destructured and parameter bindings, which the declaration patterns above miss and
// which would otherwise look like unresolved references.
for (const m of script.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g))
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().replace(/=[^,]*/, '').trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
  }
for (const m of script.matchAll(/(?:function\s*\*?\s*[A-Za-z_$][\w$]*\s*)?\(([^()]*)\)\s*(?:=>|\{)/g))
  for (const part of m[1].split(',')) {
    const name = part.replace(/=[^,]*/, '').trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
  }
for (const m of script.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]);
for (const m of script.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);

// Top-level names each sibling module defines: functions, classes and variables.
const siblings = readdirSync(new URL('.', import.meta.url))
  .filter(f => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const defined = new Map();   // name -> file
for (const f of siblings) {
  const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) if (!defined.has(m[1])) defined.set(m[1], f);
}

test('index.html declares or imports every sibling-module name it uses', () => {
  const missing = [];
  for (const [name, file] of defined) {
    if (bound.has(name)) continue;
    // A call, a property read or an index: anything that would throw on a name
    // this module does not have. A bare mention (a string, a key) would not.
    if (!new RegExp(`(?<![.\\w$])${name}\\s*[.([]`).test(mod)) continue;
    missing.push(`${name} is used in index.html but only defined in ${file}`);
  }
  assert.deepStrictEqual(missing, [], '\n' + missing.join('\n'));
});
