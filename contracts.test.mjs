// contracts.js under Node, with the kit's engine faked: the wallet's list of templates,
// the chain facts and registry name it hands the engine, the approval it renders, and
// that it signs the digest of what it rendered. The engine itself is SWK's
// (lwk_contracts); tooling/contracts-regtest.mjs drives the real one in a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  trustedTemplates, addTrusted, removeTrusted, knownHashes, chainFacts, contractCoins,
  registryName, prepare, sign, approvalSections, fundFromWallet, prevoutOf, FAUCET_DRIP, CONTRACT_KEY_PATH
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

test('funding from the wallet adds its own explicit coins for what the inputs miss, and the change', () => {
  const req = { path: 'repay', coin: { txid: 'v', vout: 0, script_pubkey: '5120', asset: 'xx', amount: 100 },
    outputs: [{ to: 'contract', script: '5120', asset: 'xx', amount: 100 }, { to: 'pay', script: '0014', asset: 'yy', amount: 70 }, { to: 'fee', asset: 'yy', amount: 5 }] }
  const coins = [
    { txid: 'a', vout: 0, asset: 'yy', amount: 40, confidential: false },
    { txid: 'b', vout: 1, asset: 'yy', amount: 50, confidential: false },
    { txid: 'c', vout: 0, asset: 'yy', amount: 900, confidential: true },
    { txid: 'd', vout: 0, asset: 'xx', amount: 900, confidential: false }]
  const r = fundFromWallet(req, coins, 'ert1qchange')
  assert.deepEqual(r.inputs, [{ is: 'contract' }, { is: 'wallet', txid: 'b', vout: 1, asset: 'yy', amount: 50 }, { is: 'wallet', txid: 'a', vout: 0, asset: 'yy', amount: 40 }])
  assert.deepEqual(r.outputs.at(-1), { to: 'wallet', address: 'ert1qchange', asset: 'yy', amount: 15 })
  assert.equal(req.inputs, undefined, 'the request handed in is left as it was')
  // A coin the request names already is not picked twice, and too little is refused.
  const named = fundFromWallet({ ...req, inputs: [{ is: 'contract' }, { is: 'wallet', txid: 'b', vout: 1, asset: 'yy', amount: 50 }] }, coins, 'ert1qchange')
  assert.equal(named.inputs.filter(i => i.txid === 'b').length, 1)
  assert.throws(() => fundFromWallet(req, coins.slice(0, 1), 'x'), /holds too little of yy in explicit coins/)
})

test('the chain\'s record of an output, and of every foreign coin a request names', async () => {
  const f = fakeFetch({ '/tx/t1': { vout: [{ scriptpubkey: '0014', value: 3, asset: 'aa' }, { scriptpubkey: '5120bb', value: 1, asset: 'be' }] } })
  assert.deepEqual(await prevoutOf(f, 't1', 1), { script_pubkey: '5120bb', asset: 'be', amount: 1 })
  await assert.rejects(prevoutOf(fakeFetch({ '/tx/t2': { vout: [{ scriptpubkey: '00', valuecommitment: '08' }] } }), 't2', 0), /not an explicit output/)
  const facts = await chainFacts(fakeFetch({ '/blocks/tip/hash': 'h9', '/block/h9': { height: 9, mediantime: 900 }, '/tx/t1/status': { confirmed: false },
    '/tx/t1': { vout: [{ scriptpubkey: '0014', value: 3, asset: 'aa' }, { scriptpubkey: '5120bb', value: 1, asset: 'be' }] } }), 't1', [['t1', 0], ['t1', 1]])
  assert.deepEqual(facts.prevouts, { 't1:0': { script_pubkey: '0014', asset: 'aa', amount: 3 }, 't1:1': { script_pubkey: '5120bb', asset: 'be', amount: 1 } })
})

test('the approval shows every input by what it is, the contract an output opens and the spender\'s values', () => {
  const s = { ...SUMMARY,
    path: { ...SUMMARY.path, selected_by: 'PATH = Left(Left(… (checked against the kit\'s table for this template)' },
    spender: [{ name: 'PATH', value: 'Left(Left(()))' }],
    inputs: [
      { index: 0, is: 'contract', shown: 'the contract\'s coin, 1.00000000 XCOL' },
      { index: 1, is: 'foreign', shown: 'a coin that is neither the contract\'s nor this wallet\'s: 1 BEACON, recreated at output 2', request_says: 'the oracle\'s beacon coin', checked_against_chain: true },
      { index: 2, is: 'wallet', shown: 'this wallet\'s coin, 2.00000000 YDEBT, signed with its funding key m/84h/1h/0h/0/3' }],
    opens: [{ index: 0, shown: 'opens pignus/vault v2 (an unregistered template, root 5fbc), holding 10.00000000 XCOL', summary: 'A loan.', template_hash: '6b17',
      params: [{ label: 'Borrower\'s payout script', role: 'script_hash', shown: 'ab (SHA-256 of this wallet\'s script 0014)' }], slots: [] }] }
  const rows = approvalSections(s).flatMap(x => x.rows.map(([k, v]) => x.title + ' | ' + k + ' | ' + v))
  for (const want of [
    'What it spends | Input 1 | a coin that is neither the contract\'s nor this wallet\'s: 1 BEACON, recreated at output 2',
    'What it spends | Input 1, as the request calls it | the oracle\'s beacon coin (the request\'s word, not checked)',
    'What it spends | Input 1, checked against the chain | yes: the chain\'s record of the coin is what the request says',
    'What it spends | Input 2 | this wallet\'s coin, 2.00000000 YDEBT, signed with its funding key m/84h/1h/0h/0/3',
    'Output 0 opens a contract | Borrower\'s payout script [script_hash] | ab (SHA-256 of this wallet\'s script 0014)',
    'Values the spender chose | PATH | Left(Left(()))',
    'Checked before signing | Path chosen by | PATH = Left(Left(… (checked against the kit\'s table for this template)'
  ]) assert.ok(rows.includes(want), want + '\n' + rows.join('\n'))
})
