// contracts.js under Node, with the kit's engine faked: the wallet's list of templates,
// the chain facts and registry name it hands the engine, the approval it renders, and
// that it signs the digest of what it rendered. The engine itself is SWK's
// (lwk_contracts); tooling/contracts-regtest.mjs drives the real one in a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  trustedTemplates, addTrusted, removeTrusted, knownHashes, chainFacts, contractCoins,
  registryName, prepare, sign, approvalSections, FAUCET_DRIP, CONTRACT_KEY_PATH
} from './contracts.js'

const memStore = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }
const res = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
const fakeFetch = (routes) => async (path) => (path in routes ? res(routes[path]) : res('missing', false))

const fakeLwk = (calls) => ({
  ContractTemplate: { knownList: () => JSON.stringify([{ hash: FAUCET_DRIP, name: 'sequentia/faucet-drip', version: 1 }]), known: (h) => ({ hash: () => h }) },
  ContractInstance: class { constructor (t, j) { calls.instance = j } },
  ContractSpend: { build: (i, n, req, scripts, facts) => { calls.build = { req: JSON.parse(req), scripts: JSON.parse(scripts), facts: JSON.parse(facts) }; return {} } },
  ContractApproval: { prepare: (spend, signer, view) => { calls.view = JSON.parse(view); return { summary: () => JSON.stringify({ digest: 'ab'.repeat(32), vsize: 581 }) } } }
})

const SUMMARY = {
  template: { shown: 'sequentia/faucet-drip v1 (registered)', hash: FAUCET_DRIP, registered: true, names_itself: 'sequentia/faucet-drip', version: 1, summary: 'A faucet reserve.' },
  path: { name: 'drip', who: 'the holder of FAUCET_KEY', effect: 'Pays output 1.', leaf: 'drip', kind: 'simplicity' },
  params: [{ name: 'ASSET', label: 'Dripped asset', role: 'asset', shown: 'tSEQ (b2e1)' }],
  slots: [],
  contract: { coin: 'aa:0', change: [{ shown: '-500.00000581 tSEQ' }] },
  wallet_change: [{ asset: 'b2e1', change: '50000000000', shown: '500.00000000 tSEQ' }],
  payments: [],
  fee: [{ shown: '0.00000581 tSEQ' }],
  vsize: 581,
  sequence: '0x00400001 (1 × 512 s)',
  locks: 'relative lock of 1 × 512 s passed',
  checks: { '1_known_template': 'known', '2_output_recomputed': 'derived', '3_program_run': 'ran', '5_contract_key': 'FAUCET_KEY is this wallet\'s contract key' },
  digest: 'cd'.repeat(32)
}

test('the wallet\'s list: the kit\'s templates and those added by hand', () => {
  const store = memStore(); const lwk = fakeLwk({})
  assert.deepEqual(knownHashes(lwk, store), [FAUCET_DRIP])
  addTrusted(store, 'ee'.repeat(32), '{"d":1}', { 'a.simf': 'fn main() {}' })
  assert.deepEqual(knownHashes(lwk, store), [FAUCET_DRIP, 'ee'.repeat(32)])
  assert.deepEqual(trustedTemplates(store)['ee'.repeat(32)].sources, { 'a.simf': 'fn main() {}' })
  removeTrusted(store, 'ee'.repeat(32))
  assert.deepEqual(knownHashes(lwk, store), [FAUCET_DRIP])
})

test('chain facts: the tip, and the median time before the coin\'s block', async () => {
  const f = await chainFacts(fakeFetch({
    '/blocks/tip/hash': 'h9', '/block/h9': { height: 9, mediantime: 900 },
    '/tx/t1/status': { confirmed: true, block_height: 5 }, '/block-height/4': 'h4', '/block/h4': { height: 4, mediantime: 400 }
  }), 't1')
  assert.deepEqual(f, { tip_height: 9, tip_median_time: 900, coin_height: 5, coin_start_median_time: 400 })
  const u = await chainFacts(fakeFetch({ '/blocks/tip/hash': 'h9', '/block/h9': { height: 9, mediantime: 900 }, '/tx/t2/status': { confirmed: false } }), 't2')
  assert.equal(u.coin_height, null)
})

test('coins: explicit ones only, in the engine\'s shape', async () => {
  const c = await contractCoins(fakeFetch({ '/address/ert1x/utxo': [
    { txid: 't', vout: 1, value: 5, asset: 'aa', status: { confirmed: true } },
    { txid: 'c', vout: 0, valuecommitment: '08..', assetcommitment: '0a..', status: { confirmed: true } }] }), 'ert1x', '5120ff')
  assert.deepEqual(c, [{ coin: { txid: 't', vout: 1, script_pubkey: '5120ff', asset: 'aa', amount: 5 }, confirmed: true }])
})

test('the registry\'s name is looked up by the wallet, by template hash', async () => {
  const idx = { leaves: { cmr1: [[FAUCET_DRIP, 'sequentia/faucet-drip', 1, 'drip', 'drip']] }, scripts: { s: ['ff'.repeat(32), 'acme/vault', 2] } }
  const f = fakeFetch({ '/contracts/index.minimal.json': idx })
  assert.deepEqual(await registryName(f, FAUCET_DRIP), { name: 'sequentia/faucet-drip', version: 1 })
  assert.deepEqual(await registryName(f, 'ff'.repeat(32)), { name: 'acme/vault', version: 2 })
  assert.equal(await registryName(f, '00'.repeat(32)), null)
  assert.equal(await registryName(fakeFetch({}), FAUCET_DRIP), null)
  assert.equal(await registryName(null, FAUCET_DRIP), null)
})

test('prepare hands the engine the wallet\'s list, its scripts, the chain and the registry\'s name; sign signs what was shown', async () => {
  const calls = {}; const signed = []
  const ctx = {
    lwk: fakeLwk(calls), store: memStore(), network: () => ({}),
    signer: () => ({ signContractSpend: (a, d) => { signed.push(d); return 'txhex' } }),
    esploraFetch: fakeFetch({ '/blocks/tip/hash': 'h9', '/block/h9': { height: 9, mediantime: 900 }, '/tx/t1/status': { confirmed: true, block_height: 5 }, '/block-height/4': 'h4', '/block/h4': { mediantime: 400 } }),
    registryFetch: fakeFetch({ '/contracts/index.minimal.json': { leaves: { c: [[FAUCET_DRIP, 'sequentia/faucet-drip', 1, 'drip', 'drip']] } } }),
    walletScripts: () => ['0014aa'], assetMeta: (h) => h === 'aa' ? { ticker: 'tSEQ', precision: 8 } : null
  }
  const request = { path: 'drip', coin: { txid: 't1', vout: 0, script_pubkey: '5120', asset: 'aa', amount: 10 }, outputs: [{ to: 'fee', asset: 'aa', amount: 1 }] }
  const p = await prepare(ctx, { template: { hash: () => FAUCET_DRIP }, instanceJson: '{}', request })
  assert.deepEqual(calls.view, { known: [FAUCET_DRIP], registry: { name: 'sequentia/faucet-drip', version: 1 }, assets: { aa: { ticker: 'tSEQ', precision: 8 } }, key_path: CONTRACT_KEY_PATH })
  assert.deepEqual(calls.build.scripts, ['0014aa'])
  assert.equal(calls.build.facts.coin_start_median_time, 400)
  assert.equal(sign(ctx, p.approval, p.summary), 'txhex')
  assert.deepEqual(signed, ['ab'.repeat(32)])
})

test('the approval shows the template, the path, the parameters by role, the balance change and the checks', () => {
  const rows = approvalSections(SUMMARY).flatMap(s => s.rows.map(([k, v]) => s.title + ' | ' + k + ' | ' + v))
  for (const want of [
    'Template | Template | sequentia/faucet-drip v1 (registered)',
    'Path | Who can take it | the holder of FAUCET_KEY',
    'Parameters | Dripped asset [asset] | tSEQ (b2e1)',
    'Your balance change | This wallet | 500.00000000 tSEQ',
    'Where the coins go | The contract | -500.00000581 tSEQ',
    'Where the coins go | Network fee | 0.00000581 tSEQ (581 vB)',
    'Checked before signing | 4. Shown | this screen; it signs digest ' + 'cd'.repeat(32)
  ]) assert.ok(rows.includes(want), want + '\n' + rows.join('\n'))
  // An unregistered template says what it calls itself, and that no registry checked it.
  const u = approvalSections({ ...SUMMARY, template: { ...SUMMARY.template, registered: false, shown: 'an unregistered template, root 5251' } })
  assert.ok(u[0].rows.some(([k, v]) => k === 'It names itself' && v.includes('not checked by any registry')))
})
