// pset-bytes.js is the browser extension's src/psetbytes.js, vendored: one header line naming the
// source commit, then the upstream file unchanged. These checks fail when the body is edited here,
// or differs from that commit upstream (read from GitHub, skipped without the network). To update
// it, vendor the file again from a new commit and set BODY_SHA256 to the new body's hash.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describeTransparent, stripBip32 } from './pset-bytes.js'

const BODY_SHA256 = 'c92baf461dc51084b77a5d0147e5763cb8e7e8c1f44ec5bd596a50639014d731'
const HEADER = /^\/\/ Vendored from ConcatenaLabs\/sequentia-extension (\S+) at ([0-9a-f]{40}), unchanged below this line/

function vendored () {
  const text = readFileSync(new URL('./pset-bytes.js', import.meta.url), 'utf8')
  const nl = text.indexOf('\n')
  const m = HEADER.exec(text.slice(0, nl))
  assert.ok(m, 'pset-bytes.js names its source file and commit on its first line')
  return { src: m[1], commit: m[2], body: text.slice(nl + 1) }
}

test('the vendored PSET reader is unchanged here', () => {
  const { body } = vendored()
  assert.equal(createHash('sha256').update(body).digest('hex'), BODY_SHA256,
    'pset-bytes.js was edited here: change it in sequentia-extension and vendor it again')
})

test('the vendored PSET reader matches its commit upstream', async (t) => {
  const { src, commit, body } = vendored()
  let r
  try { r = await fetch(`https://raw.githubusercontent.com/ConcatenaLabs/sequentia-extension/${commit}/${src}`, { signal: AbortSignal.timeout(20000) }) } catch (e) { t.skip('GitHub unreachable: ' + e.message); return }
  assert.equal(r.status, 200)
  assert.equal(await r.text(), body)
})

test('a site-built transparent PSET reads from its bytes, and still reads with key origins stripped', () => {
  const pset = readFileSync(new URL('./tooling/fixtures/levo-buy.pset', import.meta.url), 'utf8').trim()
  const t = describeTransparent(pset)
  assert.equal(t.inputs.length, 2); assert.equal(t.outputs.length, 5)
  assert.equal(t.fee, 1000000n); assert.deepEqual(t.deltas, {})
  assert.equal(describeTransparent(stripBip32(pset)).outputs.length, 5)
})
