// The wallet's id for the faucet (faucet-wallet.js): the same phrase gives the same id here, in
// Ambra browser and in Ambra mobile. The vector is the abandon phrase's first receive address,
// which all three wallets derive (Ambra mobile's classic_signing_test.dart checks the address).
//   node --test faucet-wallet.test.mjs
// With the kit's pkg/ the id is also taken from the wallet's own Wollet at index 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { scriptPubKeyOf, faucetWalletId, faucetWalletIdOf, faucetClaimed, faucetAlreadyPaid, FAUCET_WALLET_TAG } from './faucet-wallet.js'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl'
export const SPK0 = '0014d0c4a3ef09e997b6e99e397e518fe3e41a118ca1'
export const ID0 = '0dc441add97a52d9e9f9254c6d6a7aaf530c1cca887a08d9b188cb3a6b196803'
const hex = (b) => Buffer.from(b).toString('hex')

test('the id is sha256 of the tag and the first address\'s scriptPubKey', async () => {
  assert.equal(hex(scriptPubKeyOf(ADDR0)), SPK0)
  assert.equal(await faucetWalletId(SPK0), ID0)
  assert.equal(await faucetWalletId(Buffer.from(SPK0, 'hex')), ID0)
  assert.equal(await faucetWalletIdOf(ADDR0.toUpperCase()), ID0)
  assert.equal(createHash('sha256').update(FAUCET_WALLET_TAG).update(Buffer.from(SPK0, 'hex')).digest('hex'), ID0)
  // Segwit v1 and BIP-350's own vectors.
  assert.equal(hex(scriptPubKeyOf('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7')), '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262')
  assert.equal(hex(scriptPubKeyOf('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c')), '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433')
  for (const bad of ['', 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkm', 'tb1Q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl', 'not an address',
    'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvses8x3a3c'.replace('8x3a3c', 'f3hn0d')]) assert.equal(scriptPubKeyOf(bad), null, bad)
  await assert.rejects(faucetWalletIdOf('nope'))
})

const WASM = new URL('./pkg/lwk_wasm_bg.wasm', import.meta.url)
test('the wallet\'s own first receive address gives it', { skip: !existsSync(WASM) && 'needs pkg/ (the lwk_wasm build)' }, async () => {
  const lwk = await import('./pkg/lwk_wasm.js')
  lwk.initSync({ module: readFileSync(WASM) })
  const { Signer, Mnemonic, Network, Wollet } = lwk
  const network = Network.sequentiaTestnet()
  const wollet = new Wollet(network, new Signer(new Mnemonic(PHRASE), network).wpkhSlip77Descriptor())
  const a = wollet.address(0).address()
  assert.equal(a.toUnconfidential().toString(), ADDR0)
  assert.equal(hex(a.scriptPubkey().bytes()), SPK0)
  assert.equal(await faucetWalletId(a.scriptPubkey().bytes()), ID0)
})

test('what the wallet has received, and a refusal that says it has it', async () => {
  const fake = (status, body) => async (url) => { fake.url = url; return { ok: status === 200, status, json: async () => body } }
  let f = fake(200, { claimed: ['BTC', 'USDX'] })
  assert.deepEqual([...await faucetClaimed(f, '/faucet/', ID0)], ['BTC', 'USDX'])
  assert.equal(fake.url, '/faucet/claimed?wallet=' + ID0)
  assert.equal(await faucetClaimed(fake(502, {}), '/faucet', ID0), null)
  assert.equal(await faucetClaimed(async () => { throw new Error('offline') }, '/faucet', ID0), null)
  assert.equal(faucetAlreadyPaid(429, { claimed: true, reason: 'wallet' }), true)
  assert.equal(faucetAlreadyPaid(429, { claimed: false, reason: 'network' }), false)
  assert.equal(faucetAlreadyPaid(200, { claimed: true }), false)
})
