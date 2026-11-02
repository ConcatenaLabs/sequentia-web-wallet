// The page's module script parses. A page whose module does not parse loads nothing at all, and no
// other test, which each read a piece of index.html, would notice: a merge once dropped a closing
// brace and every suite still passed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

test('index.html\'s module script parses', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  const open = '<script type="module">'
  const i = html.indexOf(open)
  assert.ok(i >= 0, 'the page has a module script')
  // The browser ends the script at the first </script>, as this does.
  const src = html.slice(i + open.length, html.indexOf('</script>', i))
  const dir = mkdtempSync(join(tmpdir(), 'index-module-'))
  try {
    const f = join(dir, 'module.mjs')
    writeFileSync(f, src)
    let err = ''
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) { err = String(e.stderr || e.message) }
    assert.equal(err, '', 'the module script does not parse:\n' + err.split('\n').slice(0, 6).join('\n'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
