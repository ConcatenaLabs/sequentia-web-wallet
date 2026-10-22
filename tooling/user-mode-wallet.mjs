#!/usr/bin/env node
// One wallet of the user-mode drill (user-mode-drill.mjs), in a process of its own: the leaf
// library in Node (leaf-node.mjs) over a store of its own, and the user composer's engine
// (../user-trade.js), the same code the page runs. The drill starts it, gives it trades, and
// stops it with SIGKILL mid-trade to see the trade finish once it is started again: its trade
// records are a file written before anything is signed, as the page writes localStorage.
//
//   node tooling/user-mode-wallet.mjs --dir DIR --port PORT --config CONFIG.json
//
// CONFIG: { operator: {server, node_url, node_user, node_password}, makers: [url], relay: url,
//           pairs_file: path, genesis, exit_delay_units?, btc_rpc? }
// btc_rpc names the socket of the wallet's Bitcoin Lightning node, for BTC trades (cln-rpc.mjs).
// DIR holds `mnemonic` (written on the first start), `store/` and `trades.json`.
//
// HTTP: GET /health; GET /balance -> live atoms per asset; GET /records;
//       POST /quote {pay, receive, amount}; POST /trade {pay, receive, amount} (quote, then confirm
//       the ticket) -> { ok, ticket, record } | { ok: false, why }; POST /advance -> the open trades
//       moved on; POST /run {command, args} (setup only: address, board_quote, board, sync).
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { leafLibrary } from './leaf-node.mjs'
import { createEngine } from '../user-trade.js'
import { relayBook, lwkFrom } from './user-mode-stack.mjs'
import { clnRpc, clnBitcoinWallet } from './cln-rpc.mjs'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const dir = arg('--dir'), port = Number(arg('--port')), cfg = JSON.parse(readFileSync(arg('--config'), 'utf8'))
const mnemonicFile = join(dir, 'mnemonic')
if (!existsSync(mnemonicFile)) { const lwk = await lwkFrom(); writeFileSync(mnemonicFile, lwk.Mnemonic.fromRandom(12).toString(), { mode: 0o600 }) }
const mnemonic = readFileSync(mnemonicFile, 'utf8').trim()
const lib = await leafLibrary(join(dir, 'store'))
const op = cfg.operator
const w = lib.exists(mnemonic) ? lib.open(mnemonic, op.node_password)
  : lib.create(mnemonic, { server: op.server, node_url: op.node_url, node_user: op.node_user, node_password: op.node_password,
    ...(cfg.exit_delay_units ? { exit_delay_units: cfg.exit_delay_units, min_exit_delay_units: cfg.exit_delay_units } : {}) })

// The trade records: a file, replaced whole on every write (written before anything is signed).
const file = join(dir, 'trades.json')
const store = {
  getItem: (k) => { try { return JSON.parse(readFileSync(file, 'utf8'))[k] ?? null } catch { return null } },
  setItem: (k, v) => { let o = {}; try { o = JSON.parse(readFileSync(file, 'utf8')) } catch {} ; o[k] = v; writeFileSync(file + '.tmp', JSON.stringify(o)); renameSync(file + '.tmp', file) },
}
const fetchJson = async (url, init) => {
  const r = await fetch(url, init ? { ...init, headers: { 'content-type': 'application/json' } } : undefined)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
  return j
}
const book = relayBook(cfg.relay)
const engine = createEngine({
  leaves: w, fetchJson, makers: () => cfg.makers || [], relayBook: (pay, receive) => book(pay, receive),
  admitted: () => ({ pairs: JSON.parse(readFileSync(cfg.pairs_file, 'utf8')), genesis: cfg.genesis }),
  store, tag: () => 'drill', log: (...a) => console.log(new Date().toISOString(), ...a),
  btc: cfg.btc_rpc ? clnBitcoinWallet(clnRpc(cfg.btc_rpc)) : null,
})
const btc = cfg.btc_rpc ? clnBitcoinWallet(clnRpc(cfg.btc_rpc)) : null

// Live atoms per asset, and how many coins are still moving (not live, not spent): a balance is
// read for the drill's check only when none is.
function liveBalance () {
  const live = {}
  let moving = 0
  for (const c of w.command('coins') || []) {
    if (c.state === 'live') live[c.asset] = String(BigInt(live[c.asset] || 0) + BigInt(c.value))
    else if (!/^(spent|exited|given_up|swept|returned)$/.test(c.state)) moving++
  }
  return { live, moving }
}

let busy = Promise.resolve()
const serial = (f) => { const p = busy.then(f, f); busy = p.catch(() => {}); return p }
const send = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))) }
const body = (req) => new Promise((ok) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(p).toString() || '{}')) } catch { ok({}) } }) })

createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  try {
    if (p === '/health') return send(res, 200, { ok: true, pid: process.pid })
    if (p === '/records') return send(res, 200, engine.records())
    if (p === '/balance') {
      return send(res, 200, await serial(async () => {
        const b = liveBalance()
        // BTC is what the wallet's Bitcoin Lightning channels can send, read as the leaves are.
        if (btc) b.live.BTC = String(await btc.balance())
        return b
      }))
    }
    const b = await body(req)
    if (p === '/run') return send(res, 200, await serial(() => w.command(b.command, b.args || {})))
    if (p === '/quote') return send(res, 200, await serial(() => engine.quote({ payAsset: b.pay, receiveAsset: b.receive, amount: String(b.amount) })))
    if (p === '/trade') {
      return send(res, 200, await serial(async () => {
        const q = await engine.quote({ payAsset: b.pay, receiveAsset: b.receive, amount: String(b.amount) })
        if (!q.ok) return q
        try { return { ok: true, ticket: q.ticket, record: await engine.confirm(q.choice, q.ticket) } }
        catch (e) { return { ok: false, why: 'confirm', error: e.message, code: e.code || null } }
      }))
    }
    if (p === '/advance') return send(res, 200, await serial(() => engine.resume()))
    return send(res, 404, { error: 'no such path' })
  } catch (e) { return send(res, 500, { error: e.message }) }
}).listen(port, '127.0.0.1', () => console.log(`wallet ready on ${port} pid ${process.pid}`))
