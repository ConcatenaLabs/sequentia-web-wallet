// Coins on an own Lightning node's wallet, outside its channels (what a close paid the node, an
// interrupted deposit), go home to the wallet's own address in default mode, by themselves. The
// node's device signs that spend only to an address the wallet named to it (seqln's signer:
// withdrawal_to_an_approved_destination_is_signed); before, it signed only the node's own
// addresses and channel fundings, so the coins could leave the node only into a new channel and
// default mode showed a note about a node and a channel (03/11/2026).
//
//   node --test ln-coins-home.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const seqln = readFileSync(new URL('./seqln.js', import.meta.url), 'utf8')
const lsp = readFileSync(new URL('./tooling/lsp/lsp-server.mjs', import.meta.url), 'utf8')
const fn = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf('\n}', i) + 2) }

test('default mode sends the node\'s coins home, after naming its address to the device', () => {
  const f = fn(html, 'async function sendNodeCoinsHome(label){')
  assert.match(f, /if\(devMode\(\)\) return false;/, 'never in developer mode')
  assert.match(f, /if\(!\(info && info\.node_up && Number\(info\.onchain_msat\) > 0\)\) return false;/)
  assert.match(f, /if\(loadMoveState\(\) \|\| _lnOpenGuard\.text\(label\)\) return false;/, 'never over a Move or an open under way')
  assert.match(f, /if\(Date\.now\(\) - \(_lnHomeAt\[label\] \|\| 0\) < LN_HOME_RETRY_MS\) return false;/)
  const named = f.indexOf('approveCloseDestination(label, dest.scriptHex);'), sent = f.indexOf('await seqlnNodeWithdraw(label, dest.address);')
  assert.ok(named > 0 && sent > named, 'the address is named to the device before the node is asked')
  assert.match(f, /await lnWalletCloseDestination\(\{ chain: \/\^btc\(:\|\$\)\/i\.test\(label\) \? 'btc' : 'seq' \}\)/)
  // It runs for every node the page reconnects, once its report is read.
  assert.match(html, /sendNodeCoinsHome\(k\)\.catch\(/)
})

test('default mode shows no note about nodes and channels', () => {
  const f = fn(html, 'function renderUpgradeNote(){')
  assert.match(f, /if\(!devMode\(\)\)\{ host\.textContent = ''; host\.classList\.add\('hide'\); return; \}/)
})

test('the LSP sends a node\'s coins outside its channels to the address it is given', () => {
  assert.match(seqln, /export function seqlnNodeWithdraw\(node_key, destination\) \{\r?\n  return lspFetch\('\/node\/withdraw', \{ method: 'POST', body: JSON\.stringify\(\{ node: node_key, destination \}\) \}\);/)
  const i = lsp.indexOf("url.pathname === '/node/withdraw'"), h = lsp.slice(i, lsp.indexOf('\n    }\n', i))
  assert.ok(i > 0)
  assert.match(h, /if \(!\/\^\[0-9A-Za-z\]\{14,120\}\$\/\.test\(destination\)\) return send\(res, 400/, 'an address and nothing else')
  assert.match(h, /const args = \[`destination=\$\{destination\}`, 'satoshi=all', 'minconf=0'\];/)
  assert.match(h, /if \(rec\.chain !== 'btc'\) args\.push\(`asset=\$\{rec\.asset_id\}`\);/, 'only the node\'s own asset')
  assert.match(h, /await lnrpcKw\('withdraw', args, rec\.rpc\)/)
})
