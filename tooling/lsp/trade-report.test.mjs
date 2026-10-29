// The leaf maker's trade reports (trade-report.mjs): signed as the relay checks them, kept until
// the relay answers, sent once, dropped when refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '../../btc.js'
import { tradeReporter, reportHash, signReport, makerRelayKey } from './trade-report.mjs'

const G = '1'.repeat(64)
const trade = { rail: 'leaf-maker', id: 'sw1', give_asset: G, give: 200n, want_asset: 'BTC', want: '90' }

function derToCompact (der) {
  const b = Buffer.from(der, 'base64'); let i = 2
  const rl = b[i + 1]; const r = b.subarray(i + 2, i + 2 + rl); i += 2 + rl
  const sl = b[i + 1]; const s = b.subarray(i + 2, i + 2 + sl)
  const pad = (x) => Buffer.concat([Buffer.alloc(32), x.subarray(x.length > 32 ? x.length - 32 : 0)]).subarray(-32)
  return Buffer.concat([pad(r), pad(s)])
}

test('a report is signed over its fields by the maker key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'))
  try {
    const { priv, pub } = makerRelayKey(dir)
    const r = signReport(trade, priv)
    assert.equal(r.reporter, pub); assert.equal(r.give, '200')
    assert.ok(secp256k1.verify(derToCompact(r.sig), reportHash(r), Buffer.from(pub, 'hex'), { prehash: false }))
    assert.ok(!secp256k1.verify(derToCompact(r.sig), reportHash({ ...r, want: '91' }), Buffer.from(pub, 'hex'), { prehash: false }))
    assert.equal(makerRelayKey(dir).pub, pub, 'the key is kept')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('kept until the relay answers; dropped when refused; never queued twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'))
  try {
    let answer = 'down'; const sent = []
    const fetchImpl = async (url, o) => {
      sent.push(JSON.parse(o.body))
      if (answer === 'down') throw new Error('ECONNREFUSED')
      if (answer === 'refuse') return { ok: false, status: 403, json: async () => ({ message: 'no' }) }
      return { ok: true, status: 200, json: async () => ({ recorded: true }) }
    }
    const rep = tradeReporter({ cfg: { store_dir: dir, report: { relay: 'http://relay/' } }, log: () => {}, fetchImpl })
    rep.report(trade); rep.report(trade)
    await rep.flush()
    assert.equal(rep.pending().length, 1, 'kept while the relay is down')
    assert.ok(existsSync(join(dir, 'trade-reports.json')))
    answer = 'ok'; await rep.flush()
    assert.equal(rep.pending().length, 0)
    assert.equal(JSON.parse(readFileSync(join(dir, 'trade-reports.json'), 'utf8')).length, 0)
    answer = 'refuse'; rep.report({ ...trade, id: 'sw2' }); await rep.flush()
    assert.equal(rep.pending().length, 0, 'a refused report is dropped')
    assert.throws(() => rep.report({ ...trade, rail: 'onchain-fill' }))
    assert.equal(tradeReporter({ cfg: { store_dir: dir }, log: () => {} }), null, 'no relay named: no reports')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
