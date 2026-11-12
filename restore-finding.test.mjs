// A wallet opened in a browser for the first time restores what it holds with the page's operator
// (web wallet #365). Until the restore returns, the page says it is finding what the wallet holds,
// rather than showing what it has read so far as all there is ("showing your wallet as of … just
// now" over a balance of 0), and a payment asked meanwhile waits for it rather than saying "try
// again" once three minutes have passed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountLeaves } from './leaves.js'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const OP = 'ee'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

// A worker whose `restore` answers only when the test lets it.
function slowRestoreWorker () {
  const w = { posted: [] }
  let release
  w.restored = new Promise((r) => { release = r })
  w.release = () => release()
  w.postMessage = (m) => {
    w.posted.push(m)
    const answer = (value) => queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    if (m.op === 'exists') return answer(false)
    if (m.op === 'create') return answer({ result: { operator: OP, server_info: { assets: [] } } })
    if (m.op === 'open') return answer({})
    const c = m.args && m.args.command
    if (c === 'restore') { w.restored.then(() => answer({ result: { restored: [] }, start: {} })); return }
    const result = c === 'info' ? { operator: OP, server_info: { assets: [] } }
      : c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'balance' ? { arca: {}, sequentia_onchain: {} }
      : c === 'care' ? { claims: [], planned: [], cancelled: [], not_yet_planned: 0 } : []
    answer({ result, start: {} })
  }
  return w
}

test('#365: while the first restore runs the wallet says it is finding what it holds, and opens once it returns', async () => {
  const w = slowRestoreWorker()
  const events = []
  const api = mountLeaves({ makeWorker: () => w, store: memStore(), walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }),
    serverInfo: async () => ({ operator: OP }), onEvent: (n, d) => events.push(n), tickMs: 3_600_000 }, null, null)
  try {
    assert.equal(api.restoring(), false, 'nothing to find before the wallet starts')
    const started = api.start()
    // The restore is asked and holds.
    for (let i = 0; i < 50 && !w.posted.some((m) => m.args && m.args.command === 'restore'); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(w.posted.some((m) => m.args && m.args.command === 'restore'), 'the restore was asked')
    assert.equal(api.restoring(), true, 'the page can say the wallet is finding what it holds')
    assert.equal(api.isOpen(), false)
    assert.ok(events.includes('restoring'), 'the page is told when the finding starts, so it draws the line at once')
    assert.equal(api.expected(), true, 'a payment asked now waits for the wallet')
    w.release()
    await started
    assert.equal(api.restoring(), false)
    assert.equal(api.isOpen(), true, 'the wallet opens once the restore returns')
  } finally { api.stop && api.stop() }
})

test('#365: a wallet whose restore was done before finds nothing again and never says so', async () => {
  const w = slowRestoreWorker()
  const store = memStore()
  store.setItem('swk.leaves.restored.t', '1')
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }),
    serverInfo: async () => ({ operator: OP }), tickMs: 3_600_000 }, null, null)
  try {
    await api.start()
    assert.equal(w.posted.some((m) => m.args && m.args.command === 'restore'), false)
    assert.equal(api.restoring(), false)
    assert.equal(api.isOpen(), true)
  } finally { api.stop && api.stop() }
})

test('#365: the page says it, in default mode\'s words, and a payment waits for the restore without a cap', () => {
  for (const s of [DEFAULT_WORDS.finding, DEFAULT_WORDS.findingTip]) {
    assert.deepEqual(forbiddenIn(s), [], s)
    assert.doesNotMatch(s, /try again/i)
  }
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  // Balance and History's status line: the finding words, never "showing your wallet as of …".
  const status = html.slice(html.indexOf('function setSyncStatus('), html.indexOf('function setSyncStatus(') + 2000)
  assert.match(status, /leavesApi\.restoring\(\)/)
  assert.match(status, /DEFAULT_WORDS\.finding\b/)
  assert.ok(status.indexOf('DEFAULT_WORDS.finding') < status.indexOf('showing your wallet as of'), 'the finding line comes first')
  // Send's two waits for an opening wallet go on while it finds what it holds.
  const waits = html.match(/while\(!leavesApi\.isOpen\(\) && \(Date\.now\(\) ?< ?until \|\| leavesApi\.restoring\(\)\)\)/g) || []
  assert.equal(waits.length, 2, 'both waits run past their cap while the wallet finds what it holds')
  assert.doesNotMatch(html, /while\(!leavesApi\.isOpen\(\) && Date\.now\(\) ?< ?until\)/)
  // Receive says when the code shows; the page redraws the line and Receive when the finding starts.
  assert.match(html, /DEFAULT_WORDS\.findingTip/)
  assert.match(html, /name==='restoring'/)
})
