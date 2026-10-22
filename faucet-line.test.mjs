// The faucet's line follows the coins: "Sent …" while the wallet waits for the payment, then
// "Received … ✓ · it is in your balance" once the wallet holds the faucet's transaction, instead
// of "It'll show up once it confirms." left standing after the coins had arrived.
//   node --test faucet-line.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const i = html.indexOf('async function requestFaucet('); const body = html.slice(i, html.indexOf('\n}', i))

test('the line says Received once the wallet holds the transaction', () => {
  assert.ok(!html.includes("It'll show up once it confirms."))
  assert.match(body, /say\(`Sent \$\{what\} · `/)
  assert.match(body, /seen=wollet\.transactions\(\)\.some\(t=>t\.txid\(\)\.toString\(\)===j\.txid\)/)
  assert.match(body, /if\(seen\)\{ clearInterval\(_faucetWatch\); say\(`Received \$\{what\} ✓ · `, ' · it is in your balance\.'\); \}/)
  assert.match(body, /clearInterval\(_faucetWatch\);\s*const until=Date\.now\(\)\+10\*60\*1000;/, 'a new request replaces the last watch, and a watch ends')
})
