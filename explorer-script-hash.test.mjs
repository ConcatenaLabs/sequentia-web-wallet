// The explorer is asked for a script's coins by explorerScriptHash, and by nothing else. Pinned to
// the testnet explorer's recorded answer: the id as computed lists the coin, the byte-reversed id
// (Electrum's convention) lists nothing (web wallet #704, #708).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { explorerScriptHash } from './explorer-script-hash.js'

const here = new URL('.', import.meta.url).pathname
const REC = JSON.parse(readFileSync(join(here, 'tooling/fixtures/explorer-scripthash-answer.json'), 'utf8'))

test('the helper asks by the id under which the explorer answered with the coin', async () => {
  const id = await explorerScriptHash(REC.script)
  assert.equal(id, REC.forward)
  assert.equal(REC.utxo[id].length, 1, 'the recorded answer under the helper id lists the coin')
  assert.deepEqual(REC.utxo[REC.reversed], [], 'and the reversed id was answered with nothing')
})

test('a script that is not hex is refused rather than hashed as something else', async () => {
  await assert.rejects(() => explorerScriptHash('51z0'))
  await assert.rejects(() => explorerScriptHash(''))
})

// Every page module that asks the explorer by a script hash goes through the helper: no file
// computes its own (the reversed copy in swap.js hid an order's coins, #708).
test('no page module computes a script hash of its own', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.js') && statSync(join(here, f)).isFile())
  const offenders = []
  for (const f of files) {
    if (f === 'explorer-script-hash.js' || f === 'btc.js') continue
    const src = readFileSync(join(here, f), 'utf8')
    if (!/\/scripthash\//.test(src)) continue
    if (!/explorerScriptHash/.test(src)) offenders.push(f + ': asks /scripthash/ without explorerScriptHash')
    if (/digest\.reverse\(\)|\.reverse\(\)\s*;?\s*\/\/\s*scripthash/i.test(src)) offenders.push(f + ': reverses a digest')
  }
  assert.deepEqual(offenders, [])
})
