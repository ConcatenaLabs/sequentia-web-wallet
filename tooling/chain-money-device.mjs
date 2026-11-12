// A second device of one phrase, for chain-money-cases.test.mjs: its own leaf library and store in its
// own process (one library per process), mounted as the page mounts it. Waits for "go" on stdin, then
// moves the asset's money on the chain in (leaves.js bringIn, as a payment moved in first does) and
// pays `amount` to `request`; prints one JSON line with what it was answered.
//   node tooling/chain-money-device.mjs <storeDir> <phrase> <server> <node_url> <asset> <amount> <request>
import { mountLeaves, JOINED_KEY } from '../leaves.js'
const [dir, phrase, server, nodeUrl, asset, amount, request] = process.argv.slice(2)
const { leafLibrary } = await import('./leaf-node.mjs')
const lib = await leafLibrary(dir)
const W = lib.create(phrase, { server, node_url: nodeUrl, node_user: 'arca', node_password: 'arca' })
const asked = []
const worker = { postMessage: ({ id, op, args = {} }) => setImmediate(() => {
  let reply
  try {
    const value = op === 'exists' ? lib.exists(args.mnemonic) : op === 'open' ? true
      : op === 'run' ? (() => { try { const v = W.run(String(args.command), args.args || {}); asked.push(String(args.command)); return v } catch (e) { asked.push(args.command + ':' + (e.kind || 'error')); throw e } })()
        : (() => { throw new Error('no operation ' + op) })()
    reply = { id, ok: true, value }
  } catch (e) { reply = { id, ok: false, error: { ...e, kind: e.kind || 'error', message: e.message } } }
  worker.onmessage({ data: reply })
}) }
const m = new Map(); const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
store.setItem(JOINED_KEY + '.d2', '1')
const api = mountLeaves({ makeWorker: () => worker, store, walletTag: () => 'd2', mnemonic: () => phrase, el: () => ({}), tickMs: 3_600_000 }, null, null)
await api.start()
process.stdout.write('ready\n')
await new Promise((r) => process.stdin.once('data', r))
const since = Date.now()
let out = {}
try {
  const v = await api.bringIn(asset, { final: true, want: BigInt(amount) + 16000n, need: BigInt(amount) + 16000n, since, until: since + 5 * 60_000 })
  out.moved = v ? Object.keys(v)[0] : null
  if (v && !v.refused) { await api.payCode(request, BigInt(amount), asset); out.paid = true }
} catch (e) { out.error = String(e && e.message) }
out.asked = asked.filter((c) => /^(board|send|settle_first)(:|$)/.test(c))
process.stdout.write(JSON.stringify(out) + '\n')
api.stop()
process.exit(0)
