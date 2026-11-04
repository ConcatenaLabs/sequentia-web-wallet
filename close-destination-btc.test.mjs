// The BTC close of a channel pays an address of the wallet, named to the device by its script.
// The BTC library answers a p2wpkh's script as `script` (it has no `output`); a destination read
// from `output` threw "a is not iterable", so no BTC channel could close to the wallet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { btc, secp256k1 } from './btc.js'

test('the BTC close destination names the script the BTC library gives', () => {
  const p = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), btc.TEST_NETWORK)
  assert.ok(p.script instanceof Uint8Array && p.script.length === 22)
  assert.equal(p.output, undefined)
  const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  const fn = page.slice(page.indexOf('async function lnWalletCloseDestination'), page.indexOf('async function btcArkExitDialog'))
  assert.match(fn, /hexOfBytes\(p\.script\)/)
  assert.doesNotMatch(fn, /p\.output/)
})
