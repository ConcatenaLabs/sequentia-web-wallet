// The BTC desk's quotes never ask a wallet for more bitcoin than the maker's channels can be paid,
// nor give more than they can send, whatever the maker holds of the asset.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { btcDesk } from './leaf-maker-btc.mjs'

// A Lightning node's socket answering one call a connection, as Core Lightning does.
function fakeNode (spendSat, recvSat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-'))
  const sock = path.join(dir, 'lightning-rpc')
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      const result = req.method === 'listpeerchannels'
        ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: spendSat * 1000, receivable_msat: recvSat * 1000 }] }
        : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, close: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }) } })))
}

const X = 'aa'.repeat(32)
test('asset for BTC is quoted only up to what the channels can be paid; BTC for the asset up to what they can send', async () => {
  const n = await fakeNode(300000, 100000)
  try {
    const cfg = { store_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-store-')), fee_margin: '0',
      btc: { rpc: n.sock, keep_sats: '20000',
        pairs: [{ give: X, want: 'BTC', rate_num: '1', rate_den: '1', min_give: '1000', ladder: { levels: 4, step_bps: 25, growth: 1.4, first: '10000' } },
                { give: 'BTC', want: X, rate_num: '1', rate_den: '1', min_give: '1000', ladder: { levels: 4, step_bps: 25, growth: 1.4, first: '10000' } }] } }
    const desk = await btcDesk({ cfg, cmd: async () => { throw new Error('no operator here') }, log: () => {}, liveRates: () => new Map() })
    const q = desk.quotes(new Map([[X, 50_000_000n]]), '0')
    const toBtc = q.filter((x) => x.give_asset === X), fromBtc = q.filter((x) => x.give_asset === 'BTC')
    const deepest = (l) => l.reduce((m, x) => (BigInt(x.max_give) > m ? BigInt(x.max_give) : m), 0n)
    // 90% of 100,000 sat of room, at the ladder's worst rate (1 × 1.0075): at most 89,330 atoms
    assert.ok(deepest(toBtc) <= 89330n && deepest(toBtc) > 80000n, 'asset for BTC capped by the room to be paid: ' + deepest(toBtc))
    // 300,000 sat spendable, less the 20,000 the channels keep
    assert.equal(deepest(fromBtc), 280000n)
    fs.rmSync(cfg.store_dir, { recursive: true, force: true })
  } finally { n.close() }
})
