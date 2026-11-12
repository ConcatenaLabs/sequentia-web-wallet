// Reclaim takes a resting order's coins back with the wallet library's buildCovenantRefundTx
// (covenant-fill-host.js calls ctx.wasm.buildCovenantRefundTx). The page must hand it to the Swap
// tab, or every Reclaim of an order whose lock has opened fails with "not a function" and the
// order's coins stay in the covenant (found with web wallet #708).
//
//   node --test covenant-reclaim-wired.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const host = readFileSync(new URL('./covenant-fill-host.js', import.meta.url), 'utf8')

test('the refund builder the covenant host calls is imported from the library and given to the Swap tab', () => {
  assert.match(host, /ctx\.wasm\.buildCovenantRefundTx\(/, 'the host builds the refund with it')
  const imp = html.match(/import init, \{([^}]*)\}\s*from '\.\/pkg\/lwk_wasm\.js'/)
  assert.ok(imp, 'the page imports the wallet library by name')
  assert.match(imp[1], /\bbuildCovenantRefundTx\b/, 'imported from pkg/lwk_wasm.js')
  const at = html.indexOf('initSwap({')
  assert.ok(at > 0)
  const wasm = html.slice(at, at + 4000).match(/wasm: \{([^}]*)\}/)
  assert.ok(wasm, 'initSwap is given a wasm object')
  assert.match(wasm[1], /\bbuildCovenantRefundTx\b/, 'and Reclaim finds the refund builder in it')
})
