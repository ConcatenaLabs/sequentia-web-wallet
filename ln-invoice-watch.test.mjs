// The Receive card's invoice turns to "Received" once the hosted node lists it as paid.
//   node --test ln-invoice-watch.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { paidItem, watchInvoicePaid } from './ln-invoice-watch.js'

const H = 'ab'.repeat(32)

test('an invoice is paid once an incoming item carries its hash', () => {
  assert.equal(paidItem({ items: [] }, H), null)
  assert.equal(paidItem({ items: [{ dir: 'out', payment_hash: H }] }, H), null, 'a payment out is not a receipt')
  assert.equal(paidItem({ items: [{ dir: 'in', payment_hash: 'cd'.repeat(32) }] }, H), null, 'another invoice')
  assert.equal(paidItem({ items: [{ dir: 'in', payment_hash: H.toUpperCase(), amount_msat: 2e11 }] }, H).amount_msat, 2e11)
  assert.equal(paidItem(null, H), null)
  assert.equal(paidItem({ items: [{ dir: 'in', payment_hash: '' }] }, ''), null, 'no hash, no match')
})

test('the watcher asks until it is paid, rides out a failed read, and calls back once', async () => {
  const answers = [new Error('busy'), { items: [] }, { items: [{ dir: 'in', payment_hash: H, amount_msat: 5000 }] }]
  let asked = 0; const paid = []
  await new Promise((resolve) => {
    watchInvoicePaid({ history: async () => { const a = answers[Math.min(asked++, 2)]; if (a instanceof Error) throw a; return a },
      paymentHash: H, sleep: async () => {}, onPaid: (i) => { paid.push(i); resolve() } })
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(asked, 3); assert.equal(paid.length, 1); assert.equal(paid[0].amount_msat, 5000)
})

test('stop() ends the watch before anything is reported', async () => {
  let asked = 0; let paid = false
  const stop = watchInvoicePaid({ history: async () => { asked++; return { items: [{ dir: 'in', payment_hash: H }] } },
    paymentHash: H, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), onPaid: () => { paid = true } })
  stop()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(paid, false); assert.equal(asked, 0)
})

test('the watch gives up after its window', async () => {
  let t = 0; let asked = 0
  watchInvoicePaid({ history: async () => { asked++; return { items: [] } }, paymentHash: H, everyMs: 10, forMs: 25,
    now: () => t, sleep: async (ms) => { t += ms }, onPaid: () => assert.fail('never paid') })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(asked, 3)
})

test('the Receive card watches the invoice it made and says Received', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /import \{ watchInvoicePaid \} from '\.\/ln-invoice-watch\.js';/)
  const i = html.indexOf("if (recvBtn) recvBtn.onclick"); const body = html.slice(i, html.indexOf('if (copyBtn)', i))
  assert.match(body, /_lnRecvWatchStop\(\)/, 'a new invoice stops the watch of the previous one')
  assert.match(body, /watchInvoicePaid\(\{ history: \(\) => lnApi\.nodeHistory\(node_key\), paymentHash: inv\.payment_hash/)
  assert.match(body, /'Received ✓ '/)
})
