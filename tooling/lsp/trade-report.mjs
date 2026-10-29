// The leaf maker's trade reports: each trade it settles on a rail SeqDEX's relay cannot watch (an
// in-tree swap of its leaves, 'leaf-maker'; its BTC desk, 'btc-gateway') is reported to the relay,
// signed with the maker's relay key, so the market's one trade log, its candles and its ticker
// count it (the relay's `POST /v1/trades/report`; seqdex `daemon/README.md`, "Market data").
//
// The relay records a report only from a key it lists (`seqobd -trade-reporters`); the maker prints
// its key with `leaf-maker.mjs --config maker.json --reporter-key`. A report is kept in the store
// directory (trade-reports.json) until the relay has answered it, so a relay that is down or
// restarting gets it later; a report the relay refuses (an unlisted key) is logged and dropped.
//
// Configuration, under the maker's own: "report": { "relay": "http://127.0.0.1:9955" } (else the
// resting desk's relay, else no reports).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { secp256k1 } from '../../btc.js'
import { derEncode } from '../../seqob.js'

const hex = (b) => Buffer.from(b).toString('hex')

export const REPORT_RAILS = new Set(['leaf-maker', 'btc-gateway'])

// The maker's one key at the relay (its resting listings are signed with it too), kept beside its
// store, made on first use.
export function makerRelayKey (storeDir) {
  const keyFile = join(storeDir, 'rest-offer.key')
  if (!existsSync(keyFile)) writeFileSync(keyFile, hex(randomBytes(32)) + '\n', { mode: 0o600 })
  const priv = Uint8Array.from(Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex'))
  return { priv, pub: hex(secp256k1.getPublicKey(priv, true)) }
}

// What the reporter signs: every field but the signature, under the report's own tag.
export function reportHash (r) {
  const s = ['seqob-trade-report-v1', String(r.reporter).toLowerCase(), r.rail, r.id, r.give_asset, String(r.give), r.want_asset, String(r.want)].join('|')
  return createHash('sha256').update(s, 'utf8').digest()
}

export function signReport (trade, priv) {
  const r = { reporter: hex(secp256k1.getPublicKey(priv, true)), rail: trade.rail, id: String(trade.id),
    give_asset: trade.give_asset, give: String(trade.give), want_asset: trade.want_asset, want: String(trade.want) }
  const sig = secp256k1.sign(reportHash(r), priv, { prehash: false, lowS: true })
  const compact = sig.toCompactRawBytes ? sig.toCompactRawBytes() : sig
  r.sig = Buffer.from(derEncode(compact.subarray(0, 32), compact.subarray(32, 64))).toString('base64')
  return r
}

export function tradeReporter ({ cfg, log, fetchImpl = fetch }) {
  const relay = (cfg.report && cfg.report.relay) || (cfg.rest && cfg.rest.relay) || null
  if (!relay) return null
  const { priv, pub } = makerRelayKey(cfg.store_dir)
  const file = join(cfg.store_dir, 'trade-reports.json')
  let pending = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(pending, null, 1)); renameSync(file + '.tmp', file) }
  let flushing = null

  async function flushOnce () {
    const left = []
    for (const r of pending) {
      try {
        const res = await fetchImpl(relay.replace(/\/+$/, '') + '/v1/trades/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r), signal: AbortSignal.timeout(10000) })
        const j = await res.json().catch(() => ({}))
        if (res.ok) { log('trade reported', r.rail, r.id, j.recorded ? 'recorded' : 'held already'); continue }
        if (res.status >= 400 && res.status < 500) { log('trade report refused', r.rail, r.id, res.status, j.message || ''); continue }
        left.push(r)
      } catch (e) { left.push(r) }
    }
    pending = left
    save()
  }
  const flush = () => { if (!flushing) flushing = flushOnce().finally(() => { flushing = null }); return flushing }

  // A trade the maker settled: it gave `give` of give_asset for `want` of want_asset.
  function report (trade) {
    if (!REPORT_RAILS.has(trade.rail)) throw new Error('a maker reports leaf-maker or btc-gateway trades only')
    if (pending.some((r) => r.rail === trade.rail && r.id === String(trade.id))) return
    pending.push(signReport(trade, priv))
    save()
    flush().catch(() => {})
  }

  return { report, flush, pub, relay, pending: () => pending.slice() }
}
