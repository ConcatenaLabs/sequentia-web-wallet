// The leaf wallet library's pause, run by tooling/leaf-node.mjs as the makers and drills run it:
// the module gives the library a wait on a shared buffer (setPause), so a 2 s pause costs the
// thread almost no processor time. Before that wait, the library watched the clock and a pause
// cost the whole of it (arca #830). Skips when leaves/pkg (or LEAVES_PKG) has no pause.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const store = mkdtempSync(join(tmpdir(), 'leaf-pause-'))
let lib = null, why = null
try { lib = await (await import('./tooling/leaf-node.mjs')).leafLibrary(store) } catch (e) { why = 'the leaf library does not load here: ' + e.message }
if (lib && !lib.pause) why = 'this build of the leaf library has no pause'
after(() => rmSync(store, { recursive: true, force: true }))

test('a 2 s pause of the leaf library costs under 50 ms of processor time', { skip: why || false }, () => {
  {
    const c0 = process.cpuUsage(), t0 = performance.now()
    lib.pause(2000)
    const c = process.cpuUsage(c0), wall = performance.now() - t0
    const cpu = (c.user + c.system) / 1000
    assert.ok(wall >= 2000, `the pause took ${wall.toFixed(0)} ms`)
    assert.ok(cpu < 50, `the pause cost ${cpu.toFixed(1)} ms of processor`)
  }
})
