// restricted-host.js: what the page's host asks the chain's explorer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { scriptHash, makeRestrictedHost } from './restricted-host.js'

// An enclave on the testnet holding RSTB, and the id the testnet's explorer answers its coins by
// (its /api/scripthash/<id>/utxo lists them; the reversed form lists none).
const ENCLAVE = '5120092086c67f869fdec674bc65d7efb1a9b28bd3890467ddd4fe9e8d1e37a4d3b8'
const ESPLORA_ID = '66c4ede582b57132081ef120208acd3494144fdf7d234be1ee94defa48566748'.match(/../g).reverse().join('')

test('a script\'s explorer id is its SHA-256 as computed, never reversed', () => {
  assert.equal(scriptHash(ENCLAVE), createHash('sha256').update(Buffer.from(ENCLAVE, 'hex')).digest('hex'))
  assert.equal(scriptHash(ENCLAVE), ESPLORA_ID)
})

test('the coins at the wallet\'s enclave are read where the explorer lists them (a sale finds what it sells)', async () => {
  const asked = []
  const RSTB = 'aa'.repeat(32)
  const ctx = {
    aid: () => 'AID', policyBase: () => 'http://policy',
    fetchJson: async (url) => { if (/\/address\?asset=/.test(url)) return { script_pubkey: ENCLAVE }; throw new Error('no ' + url) },
    esplora: async (path) => {
      asked.push(path)
      if (path === `/scripthash/${ESPLORA_ID}/utxo`) return [{ txid: '01'.repeat(32), vout: 0 }]
      if (path.startsWith('/scripthash/')) return []
      if (path === `/tx/${'01'.repeat(32)}`) return { vout: [{ value: 100, asset: RSTB, scriptpubkey: ENCLAVE }] }
      if (path.includes('/outspend/')) return { spent: false }
      throw new Error('no ' + path)
    },
  }
  const coins = await makeRestrictedHost(ctx).enclaveCoins(RSTB)
  assert.deepEqual(coins.map((c) => [c.asset, c.value]), [[RSTB, 100n]], 'asked: ' + asked.join(' '))
})
