// wallet-api.js: the page API's methods, its refusals and its approvals, against a fake
// leaf module; the library itself is driven in a browser by tooling/leaves-drive.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountPageApi, NOT_DEVELOPER, NOT_JOINED, METHODS } from './wallet-api.js'

const X = '75'.repeat(32)
const hex = (v) => Buffer.from(JSON.stringify(v)).toString('hex')

function fakeLeaves ({ mode = 'developer', open = true } = {}) {
  const calls = []
  const answers = {
    info: { genesis_hash: 'g', operator: 'o' },
    balance: { arca: { [X]: { live: '700' } }, sequentia_onchain: { [X]: '50' }, total: null },
    schedule: { now: 10, next_sync_at: 20, due: false },
    board_quote: { fee: { asset: X, amount: '30' }, vsize: 270, inputs: 1 },
    board: { leaf_id: 'l1', fee: { asset: X, amount: '30' } },
    exit_quote: { asset: X, value: '1000', fee_asset: X, steps: [{ vsize: 375, fee: [{ asset: X, amount: '40' }], paid_by: 'a fee coin of the wallet\'s' }],
      unroll: { [X]: '40' }, claim: { fee: [{ asset: X, amount: '22' }], pays: '978' }, exit_delay_seconds: 512 },
    exit: { state: 'unrolling', broadcast: [] },
    receive: { request: 'request:00' },
    send: { sent: { asset: X, value: '5' } },
  }
  const L = {
    calls, state: { mode, open },
    mode: () => L.state.mode,
    isOpen: () => L.state.open,
    command: async (cmd, args) => { calls.push([cmd, args || {}]); return answers[cmd] },
    address: async () => ({ address: 'el1qq', script_pubkey: '0014aa' }),
  }
  return L
}

function mount (L, decisions = []) {
  const shown = []
  const p = mountPageApi({
    leaves: L, assetMeta: () => ({ ticker: 'X', precision: 0 }), fmtAtoms: (a) => String(a),
    confirm: async (d) => { shown.push(d); return decisions.length ? decisions.shift() : true },
  })
  return { p, shown }
}

test('the mode reads silently; the leaf methods answer in developer mode only, with the operator joined', async () => {
  const L = fakeLeaves({ mode: 'user' })
  const { p, shown } = mount(L)
  assert.deepEqual(await p.request({ method: 'getWalletMode' }), { mode: 'user' })
  for (const method of ['getLeafBalances', 'getLeafAddress', 'requestLeafReceive', 'boardLeaves', 'exitLeaf']) {
    const params = method === 'boardLeaves' ? { asset: X, amount: '1000' } : method === 'exitLeaf' ? { leaf_id: 'l1' } : {}
    await assert.rejects(p.request({ method, params }), { message: NOT_DEVELOPER }, method)
  }
  await assert.rejects(p.request({ method: 'sendLeaves', params: { request: 'request:' + hex({ kind: 'request' }) } }), { message: NOT_DEVELOPER })
  L.state.mode = 'developer'; L.state.open = false
  await assert.rejects(p.request({ method: 'getLeafBalances' }), { message: NOT_JOINED })
  assert.equal(shown.length, 0, 'nothing refused ever reached the user as a decision')
  assert.deepEqual(L.calls, [], 'nothing refused ever reached the library')
  assert.deepEqual((await p.request({ method: 'getCapabilities' })).methods, METHODS)
})

test('a board shows the library\'s quote and goes ahead only on the fee shown', async () => {
  const L = fakeLeaves()
  const { p, shown } = mount(L)
  await assert.rejects(p.request({ method: 'boardLeaves', params: { asset: 'zz', amount: '1' } }), /64-hex/)
  await assert.rejects(p.request({ method: 'boardLeaves', params: { asset: X, amount: '0' } }), /positive/)
  const v = await p.request({ method: 'boardLeaves', params: { asset: X, amount: '1000' } })
  assert.equal(v.leaf_id, 'l1')
  assert.equal(shown[0].title, 'Board a coin into your leaves?')
  assert.ok(shown[0].rows.some(([k, val]) => k === 'Fee' && /30 X \(30 atoms\)/.test(val)), JSON.stringify(shown[0].rows))
  assert.deepEqual(L.calls, [['board_quote', { asset: X, amount: '1000' }], ['board', { asset: X, amount: '1000', shown: { asset: X, amount: '30' } }]])
})

test('an exit shows each transaction\'s fee and the claim\'s, and broadcasts only on the fees shown', async () => {
  const L = fakeLeaves()
  const { p, shown } = mount(L)
  await p.request({ method: 'exitLeaf', params: { leaf_id: 'l1' } })
  const rows = Object.fromEntries(shown[0].rows)
  assert.match(rows['Transaction 1'], /375 vB, fee 40 X \(40 atoms\), paid from a fee coin/)
  assert.match(rows['Claim, later'], /22 X/)
  assert.equal(rows['Exit delay'], '0.1 h after the leaf’s transaction is in a block')
  assert.deepEqual(L.calls[1], ['exit', { leaf_id: 'l1', shown: { [X]: '40' }, fee_asset: X }])
})

test('a rejected approval runs nothing', async () => {
  const L = fakeLeaves()
  const { p } = mount(L, [false])
  await assert.rejects(p.request({ method: 'exitLeaf', params: { leaf_id: 'l1' } }), /rejected/)
  assert.deepEqual(L.calls.map((c) => c[0]), ['exit_quote'])
})

test('the leaf address is silent; balances in the provider\'s shape', async () => {
  const L = fakeLeaves()
  const { p, shown } = mount(L)
  assert.deepEqual(await p.request({ method: 'getLeafAddress' }), { address: 'el1qq', script_pubkey: '0014aa' })
  const b = await p.request({ method: 'getLeafBalances' })
  assert.deepEqual(b.leaves, { [X]: { total: '700', states: { live: '700' } } })
  assert.equal(shown.length, 0)
})

test('mode and leaf events: the mode always, the leaf events in developer mode only, and the mode over the channel', async () => {
  const L = fakeLeaves()
  const posted = []
  const ch = { postMessage: (m) => posted.push(m), onmessage: null }
  const p = mountPageApi({ leaves: L, assetMeta: () => ({}), fmtAtoms: String, confirm: async () => true, channel: ch })
  const heard = []
  p.api.on('modeChanged', (d) => heard.push(['modeChanged', d])).on('leafArrived', (d) => heard.push(['leafArrived', d]))
  p.leafEvent('leafArrived', { value: '1' })
  L.state.mode = 'user'
  p.modeChanged('user')
  p.leafEvent('leafArrived', { value: '2' })
  assert.deepEqual(heard, [['leafArrived', { value: '1' }], ['modeChanged', { mode: 'user' }]])
  assert.deepEqual(posted, [{ type: 'event', event: 'modeChanged', data: { mode: 'user' } }])
  ch.onmessage({ data: { type: 'request', id: 7, method: 'getWalletMode' } })
  ch.onmessage({ data: { type: 'request', id: 8, method: 'getLeafBalances' } })
  assert.deepEqual(posted[1], { type: 'answer', id: 7, ok: true, result: { mode: 'user' } })
  assert.equal(posted[2].ok, false)
  assert.match(posted[2].error, /only getWalletMode/)
})
