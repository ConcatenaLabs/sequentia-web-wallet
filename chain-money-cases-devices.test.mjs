// Money received on the chain, on the real leaf wallet library and a real operator: two devices of one phrase asking at once.
// index.html's own routes and reviews over leaves.js. The harness runs with ARCA_OPERATOR_SUPERVISED=1
// and its anchor depth from ARCA_TEST_ANCHOR_DEPTH:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18751 LWK_PKG=<lwk_wasm pkg> node --test chain-money-cases-devices.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DEFAULT_WORDS, codeMost } from './default-arca.js'
import { buildPayCode } from './pay-code.js'
import { skip, setup, send, textOf, page, heldX, sleep, CONTROL, PKG } from './tooling/chain-money-harness.mjs'

test('money received on the chain: two devices of one phrase asking at once', { skip, timeout: 3_000_000 }, async (t) => {
  const { H, st, X, cfg, dir, B, bHolds, info, minX, wallet, release, moved, fresh } = await setup(t)
  await t.test('two devices on one phrase, each sending at once with money moved in: each paid once at most', async () => {
    release()
    const phrase = fresh()
    const D1 = await wallet(phrase)
    await D1.paid(3_000_000)
    const before = bHolds()
    // The second device: its own process, library and store.
    const { spawn } = await import('node:child_process')
    const req2 = B.command('receive').request
    const child = spawn(process.execPath, [new URL('./tooling/chain-money-device.mjs', import.meta.url).pathname, join(dir, 'device2'), phrase, cfg.server, cfg.node_url, X, '600000', req2],
      { env: { ...process.env, LEAVES_PKG: PKG }, stdio: ['pipe', 'pipe', 'inherit'] })
    let outText = ''
    child.stdout.on('data', (b) => { outText += b })
    for (let i = 0; i < 120 && !outText.includes('ready'); i++) await sleep(500)
    assert.ok(outText.includes('ready'), 'the second device opened')
    await D1.p.treeSendReview({ asset: X, amtS: '0.004', addr: B.command('receive').request, bringIn: true }, () => {})
    child.stdin.write('go\n')
    const ended = new Promise((r) => child.on('exit', r))
    const r1 = await send(H, D1.p.modals[0])
    let done = false
    const pump = (async () => { while (!done) { try { await H.produce(); await H.bury(); await H.round() } catch {} await sleep(2500) } })()
    await Promise.race([ended, sleep(600_000)]); done = true; await pump
    const d2 = JSON.parse(outText.split('\n').filter((l) => l.startsWith('{')).pop() || '{}')
    console.log(`two devices: device 1 ${JSON.stringify(r1.said)} [${moved(D1).join(',')}]; device 2 ${JSON.stringify(d2)}`)
    const got = bHolds() - before
    console.log('two devices: B received ' + got)
    assert.ok(got <= 1_000_000n, 'never paid twice')
    assert.ok(!/something went wrong|try again/i.test(r1.status.textContent), r1.status.textContent)
  })
})
