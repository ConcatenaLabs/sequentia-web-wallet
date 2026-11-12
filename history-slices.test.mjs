// A wallet restored from its phrase checks its history after it opens (web wallet #694). The
// page runs that history in slices of about HISTORY_SLICE_MS while nobody asks the wallet for
// anything, so what a person asks (here, a payment's quote) waits for one slice at most, never
// for the whole history; and the history still ends without a sync driving it.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as leaves from './leaves.js'
const { mountLeaves } = leaves

const OP = 'ee'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A worker that runs one command at a time, as the leaf library's does. Each slice of the history
// takes `sliceMs` (the library's own bound, a slice running past its budget by the coin it was
// checking) and checks one coin; `restore_history` without a budget is a whole step of twenty
// coins, `stepMs` long, as the library's step was.
function historyWorker ({ left, sliceMs, stepMs }) {
  const w = { posted: [], left, slices: 0, budgets: [] }
  let chain = Promise.resolve()
  const result = (c, args) => {
    if (c === 'info') return { operator: OP, server_info: { assets: [] } }
    if (c === 'schedule') return { now: 1, due: false, next_sync_at: null }
    if (c === 'balance') return { arca: {}, sequentia_onchain: {}, history: w.left > 0 ? { loading: true, left: w.left } : null }
    if (c === 'care') return { claims: [], planned: [], cancelled: [], not_yet_planned: 0 }
    if (c === 'restore_history') {
      w.budgets.push(args && args.budget_ms)
      const n = args && args.budget_ms ? 1 : 20
      const checked = Math.min(n, w.left)
      w.left -= checked; w.slices++
      return w.old ? { checked, left: w.left, loading: w.left > 0 } : { checked, left: w.left, loading: w.left > 0, ms: took(c, args) }
    }
    if (c === 'send_quote') return { fee: '1' }
    return []
  }
  const took = (c, args) => c === 'restore_history' ? (args && args.budget_ms ? sliceMs : stepMs) : c === 'send_quote' ? 20 : 1
  w.postMessage = (m) => {
    w.posted.push(m)
    chain = chain.then(async () => {
      if (m.op === 'exists') return w.onmessage({ data: { id: m.id, ok: true, value: true } })
      if (m.op === 'open' || m.op === 'create') return w.onmessage({ data: { id: m.id, ok: true, value: {} } })
      const c = m.args && m.args.command
      const args = m.args && m.args.args
      await sleep(took(c, args))
      w.onmessage({ data: { id: m.id, ok: true, value: { result: result(c, args), start: {} } } })
    })
  }
  return w
}

test('#694: the history runs in slices while nobody asks; a quote asked meanwhile waits one slice at most', async () => {
  const w = historyWorker({ left: 12, sliceMs: 450, stepMs: 9_000 })
  const store = memStore()
  store.setItem('swk.leaves.restored.t', '1')
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }),
    serverInfo: async () => ({ operator: OP }), tickMs: 3_600_000 }, null, null)
  const waits = []
  try {
    await api.start()
    // Quotes asked at moments that fall inside slices, as a person asks: each waits at most for
    // the slice running when it was asked.
    const t0 = Date.now()
    while (w.left > 0 && Date.now() - t0 < 15_000) {
      await sleep(170 + (waits.length * 97) % 300)
      if (w.left === 0) break
      const t = Date.now()
      await api.sendQuote('anything', 1000n, '00'.repeat(32))
      waits.push(Date.now() - t)
    }
    for (let i = 0; i < 100 && w.left > 0; i++) await sleep(100)
    console.log(`history in ${w.slices} slices of budgets ${[...new Set(w.budgets)]}; quotes waited ${waits.join(', ')} ms`)
    assert.equal(w.left, 0, 'the page ran the history to its end, a slice at a time')
    assert.ok(w.budgets.length > 0 && w.budgets.every((b) => b === leaves.HISTORY_SLICE_MS), `every slice asked with its budget: ${w.budgets}`)
    assert.ok(waits.length >= 5, `quotes were asked while the history loaded: ${waits.length}`)
    assert.ok(Math.max(...waits) < 1000, `no quote waits more than about a second: ${waits}`)
  } finally { api.stop && api.stop() }
})

test('#694: a library without slices (no `ms` in its answer) is asked once, and its syncs carry the history', async () => {
  const w = historyWorker({ left: 40, sliceMs: 20, stepMs: 20 })
  w.old = true
  const store = memStore()
  store.setItem('swk.leaves.restored.t', '1')
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }),
    serverInfo: async () => ({ operator: OP }), tickMs: 3_600_000 }, null, null)
  try {
    await api.start()
    await sleep(1500)
    assert.equal(w.slices, 1, `asked ${w.slices} times`)
  } finally { api.stop && api.stop() }
})
