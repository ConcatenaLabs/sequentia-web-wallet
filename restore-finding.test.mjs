// A wallet opened in a browser for the first time restores what it holds with the page's operator
// (web wallet #365). Until the restore returns, the page says it is finding what the wallet holds,
// rather than showing what it has read so far as all there is ("showing your wallet as of … just
// now" over a balance of 0), and a payment asked meanwhile waits for it rather than saying "try
// again" once three minutes have passed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as leaves from './leaves.js'
const { mountLeaves } = leaves
const RESTORE_RETRY_MS = leaves.RESTORE_RETRY_MS ?? 30_000
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const OP = 'ee'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

// A worker whose `restore` answers only when the test lets it; while `down`, it answers as the
// library does when the operator does not answer (kind `unreachable`).
function slowRestoreWorker () {
  const w = { posted: [], down: false }
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
    if (c === 'restore' && w.down) {
      return queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: false, error: { kind: 'unreachable', message: 'the operator\'s server did not answer: POST https://op/v1/leaf_data: no answer' } } }))
    }
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

test('#365: the page says it, in default mode\'s words, and both payment waits follow the restore', () => {
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
  // Send's two waits for an opening wallet go on while it finds what it holds, and end at once
  // when the operator does not answer it.
  const waits = html.match(/while\(!leavesApi\.isOpen\(\) && !findingStalled\(\) && \(Date\.now\(\) ?< ?until \|\| findingOn\(\)\)\)/g) || []
  assert.equal(waits.length, 2, 'both waits run past their cap while the wallet finds what it holds')
  assert.doesNotMatch(html, /while\(!leavesApi\.isOpen\(\) && Date\.now\(\) ?< ?until\)/)
  // Receive says when the code shows; the page redraws the line and Receive when the finding starts.
  assert.match(html, /DEFAULT_WORDS\.findingTip/)
  assert.match(html, /name==='restoring'/)
})

// index.html's own functions, mounted with the real leaf wallet module: the status line, and the
// wait of a payment that needs the wallet open (ensureOnChain, to its first step on an open wallet).
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }
function page (leavesApi) {
  const shown = {}
  const $ = (id) => (shown[id] = shown[id] || { className: '', innerHTML: '' })
  const waitTo = fn('ensureOnChain').split('\n')
  const cut = waitTo.findIndex((l) => l.includes('DEFAULT_WORDS.stillOpening'))
  const ensure = waitTo.slice(0, cut + 1).join('\n') + "\n  return 'went on'\n}"
  const src = [fn('findingStalled'), fn('findingOn'), fn('setSyncStatus'), ensure,
    'return { setSyncStatus, ensureOnChain, line: () => $("syncStatus").innerHTML.replace(/<[^>]*>/g, "") }'].join('\n')
  // eslint-disable-next-line no-new-func
  return new Function('leavesApi', 'DEFAULT_WORDS', '$', 'esc', 'whenText', 'OPEN_WAIT_MS', 'devMode', 'refuseIfVesting', 'instantAtoms', 'fmtAmount', 'assetMeta',
    'let _syncState = null, _scannedOnce = true, _snap = { at: 1 }, _lastSyncOk = 0;\n' + src)(
    leavesApi, DEFAULT_WORDS, $, (x) => String(x), () => 'just now', 50, () => false, () => {}, () => 0n, String, () => ({ precision: 8, ticker: 'X' }))
}
const mountWith = (w, extra = {}) => mountLeaves({ makeWorker: () => w, store: memStore(), walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
  pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }), serverInfo: async () => ({ operator: OP }), tickMs: 3_600_000, ...extra }, null, null)
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('waited ' + ms + ' ms'); await new Promise((r) => setTimeout(r, 5)) } }
const asksRestore = (w) => w.posted.filter((m) => m.args && m.args.command === 'restore').length

test('#365: a payment asked while the wallet finds what it holds waits past three minutes\' cap, and goes on once it opens', async () => {
  const w = slowRestoreWorker()
  const api = mountWith(w)
  const p = page(api)
  try {
    const started = api.start()
    await until(() => asksRestore(w) === 1)
    p.setSyncStatus('ok')
    assert.equal(p.line(), DEFAULT_WORDS.finding, 'never a figure as of a time while it finds')
    const said = []
    const paying = p.ensureOnChain([{ hex: 'aa', atoms: 10n }], (t) => said.push(t), 'send', () => 0n)
    // The page's cap (here 50 ms) passes; the payment still waits, as the restore runs.
    await new Promise((r) => setTimeout(r, 1500))
    let settled = false; paying.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(settled, false, 'still waiting for the wallet, past the cap')
    assert.deepEqual(said, [DEFAULT_WORDS.waitOpening])
    w.release()
    await started
    assert.equal(await paying, 'went on', 'it goes on by itself once the wallet opens')
  } finally { api.stop() }
})

test('#365: the operator does not answer the restore: the wallet stays finding and says why, a waiting payment ends in true words, and it opens once the operator answers', async () => {
  const w = slowRestoreWorker()
  w.down = true
  const events = []
  const api = mountWith(w, { sleep: (ms) => new Promise((r) => setTimeout(r, ms === RESTORE_RETRY_MS ? 20 : ms)), onEvent: (n, d) => events.push([n, d]) })
  const p = page(api)
  try {
    const started = api.start()
    const said = []
    const paying = p.ensureOnChain([{ hex: 'aa', atoms: 10n }], (t) => said.push(t), 'send', () => 0n)
    await until(() => asksRestore(w) >= 2)
    assert.equal(api.isOpen(), false, 'never opened empty, as if it held nothing')
    assert.equal(api.restoring(), true)
    assert.match(api.restoreStalled().why, /did not answer/)
    assert.ok(events.some(([n, d]) => n === 'restoring' && d.stalled), 'the page is told, to draw the line again')
    p.setSyncStatus('ok')
    assert.equal(p.line(), DEFAULT_WORDS.findingStalled)
    await assert.rejects(paying, (e) => e.message === DEFAULT_WORDS.findingStalledPay)
    for (const t of [DEFAULT_WORDS.findingStalled, DEFAULT_WORDS.findingStalledPay]) {
      assert.deepEqual(forbiddenIn(t), [], t)
      assert.doesNotMatch(t, /try again/i)
    }
    // The operator answers: the next try restores, and the wallet opens.
    w.down = false
    w.release()
    await started
    assert.equal(api.restoring(), false)
    assert.equal(api.isOpen(), true)
    p.setSyncStatus('ok')
    assert.equal(p.line(), 'Up to date.')
  } finally { api.stop() }
})

test('#365: a restore refused for another reason ends the finding: the wallet opens as before', async () => {
  const w = slowRestoreWorker()
  const post = w.postMessage
  w.postMessage = (m) => (m.args && m.args.command === 'restore')
    ? (w.posted.push(m), queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: false, error: { kind: 'refused', message: 'refused: something else' } } })))
    : post(m)
  const api = mountWith(w)
  try {
    await api.start()
    assert.equal(asksRestore(w), 1, 'asked once, not again and again')
    assert.equal(api.restoring(), false)
    assert.equal(api.isOpen(), true)
  } finally { api.stop() }
})
