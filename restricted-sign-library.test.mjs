// The page selling a restricted asset into a maker's buy quote (takeDvP, maker-buys branch), signed
// the way index.html signs it: makeRestrictedHost.signWallet -> psetOf -> the wallet library (Pset,
// addDetails, Signer.sign, Wollet.finalize). Needs ./pkg (the SWK wasm build); skips without it,
// as CI does. Written by proof review PV12 of #681: at aa3359ca the honest case is refused, since
// the library returns the trade without the maker's witness and checkSigned reads that as a change.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as m from './restricted-trade.js'
import { makeRestrictedHost } from './restricted-host.js'
import { HDKey } from './btc.js'

const PKG = new URL('./pkg/', import.meta.url)
const have = fs.existsSync(new URL('lwk_wasm_bg.wasm', PKG))

async function wallet () {
  const pkg = await import(new URL('lwk_wasm.js', PKG).href)
  await pkg.default({ module_or_path: fs.readFileSync(new URL('lwk_wasm_bg.wasm', PKG)) })
  const { Network, Signer, Mnemonic, Wollet, Pset, Bip } = pkg
  const network = Network.sequentiaTestnet()
  const signer = new Signer(new Mnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), network)
  const wollet = new Wollet(network, signer.wpkhSlip77Descriptor())
  const mm = signer.keyoriginXpub(Bip.bip84()).match(/^\[([0-9a-f]{8})\/(.*)\](\w+)$/)
  const base = mm[2].split('/').map((x) => (/['h]$/.test(x) ? (parseInt(x) + 0x80000000) >>> 0 : parseInt(x)))
  const hd = HDKey.fromExtendedKey(mm[3], { private: 0x04358394, public: 0x043587cf })
  return {
    script: (i) => wollet.address(i).address().scriptPubkey().toString(),
    keyOrigin: () => ({ fingerprint: mm[1], path: base, pubkey: (c, i) => Buffer.from(hd.deriveChild(c).deriveChild(i).publicKey).toString('hex') }),
    // index.html's ctx.sign
    sign: (b64) => { const p = new Pset(b64); try { p.addDetails(wollet) } catch {} return wollet.finalize(signer.sign(p)).extractTx().toString() },
  }
}

const R = 'aa'.repeat(32); const B = 'bb'.repeat(31) + '01'; const F = 'cc'.repeat(31) + '02'
const PX = '9f'.repeat(32); const MINE = '5120' + 'e1'.repeat(32); const MAKER = '5120' + 'e2'.repeat(32)
const MAKER_WIT = ['30' + '44'.repeat(70) + '01', '02' + '99'.repeat(32)]

// The page's host over a scripted explorer and policy server; `late` coins are listed only from the
// second read of the wallet's coins on (a coin the wallet lists again after the trade was checked).
function setup (w, { makerCoin, late = [] }) {
  const coins = {
    [`${'a2'.repeat(32)}:0`]: { asset: R, value: 300n, script: MINE },
    [`${'f1'.repeat(32)}:0`]: { asset: F, value: 9000n, script: w.script(0), mine: true, idx: 0 },
    [`${'b2'.repeat(32)}:1`]: { asset: B, value: 5000n, script: '0014' + '77'.repeat(20) },
    [`${'b3'.repeat(32)}:0`]: { asset: B, value: 4000n, script: w.script(1), idx: 1 },
  }
  let reads = 0
  const cosigned = []
  const host = makeRestrictedHost({
    policyBase: () => 'P', aid: () => 'aa11'.repeat(10),
    utxos: () => { reads++; return Object.entries(coins).filter(([k, c]) => c.mine || (reads > 1 && late.includes(k))).map(([k, c]) => ({ txid: k.split(':')[0], vout: +k.split(':')[1], asset: c.asset, value: String(c.value), scriptPubkey: c.script, chain: 0, index: c.idx })) },
    keyOrigin: w.keyOrigin, sign: w.sign,
    enclaveSighash: () => '00'.repeat(32), signDigest: () => '11'.repeat(64),
    receiveScript: () => w.script(0), scriptOf: () => '0014' + '88'.repeat(20), feeAtoms: () => 100n,
    esplora: async (p) => {
      let x
      if ((x = p.match(/\/outspend\//))) return { spent: false }
      if ((x = p.match(/^\/scripthash\/\w+\/utxo$/))) return Object.keys(coins).filter((k) => coins[k].script === MINE).map((k) => ({ txid: k.split(':')[0], vout: +k.split(':')[1] }))
      if ((x = p.match(/^\/tx\/(\w{64})$/))) { const vout = []; for (const [k, c] of Object.entries(coins)) if (k.startsWith(x[1])) vout[+k.split(':')[1]] = { value: Number(c.value), asset: c.asset, scriptpubkey: c.script }; return { vout } }
      throw new Error('no ' + p)
    },
    courier: async () => courier,
    fetchJson: async (url, init) => {
      const path = url.slice(1); const body = init && init.body ? JSON.parse(init.body) : null
      if (path.startsWith('/v1/assets/')) return { enforcement: 'cosign', policy_pub: PX }
      if (path.startsWith('/v1/users/')) return { script_pubkey: path.includes('aa11'.repeat(10)) ? MINE : MAKER, transfer_leaf: 'c0', transfer_control: 'c4' }
      if (path === '/v1/check') return { ok: true }
      if (path === '/v1/cosign') { cosigned.push(body); return { txid: m.readTx(body.tx).txid } }
      throw new Error('no ' + path)
    },
    now: () => 1_800_000_000,
  })
  const [txid, vout] = makerCoin.split(':')
  const inbox = [{ type: 'dvp_coins', dvp_coins: [{ Txid: txid, Vout: +vout }], dvp_change: '0014' + '99'.repeat(20) }]
  const sent = []
  const courier = {
    send: async (x) => { sent.push(x); if (x.type === 'dvp_tx') { const t = m.readTx(x.dvp_tx); inbox.push({ type: 'dvp_signed', dvp_tx: m.setWitnesses(x.dvp_tx, t.inputs.map((i) => (`${i.txid}:${i.vout}` === makerCoin ? MAKER_WIT : []))) }) } },
    recv: async () => { const x = inbox.shift(); if (!x) throw new Error('no answer in time'); return x },
    fail: async (code, message) => { sent.push({ type: 'fail', code, message }) }, close () {},
  }
  const offer = { _verified: true, offer_id: 'o', pair: { base_asset: R, quote_asset: B }, trade_dir: 'TRADE_DIR_BUY', base_amount: '100', offer_amount: '700', want_amount: '100',
    restricted: { policy_server: 'P', policy_x: PX, maker_aid: 'bb22'.repeat(10), maker_recv_address: 'x' } }
  const entry = m.restrictedEntries([offer], { payAsset: R, receiveAsset: B })[0]
  return { host, entry, cosigned, sent }
}

test('selling into a maker\'s buy quote: the library signs the page\'s input and the maker\'s witness stays', { skip: !have && 'pkg/ is absent' }, async () => {
  const w = await wallet()
  const { host, entry, cosigned } = setup(w, { makerCoin: `${'b2'.repeat(32)}:1` })
  const r = await m.takeDvP(host, entry, { feeAsset: F })
  assert.equal(cosigned.length, 1)
  const t = m.readTx(cosigned[0].tx)
  assert.equal(r.txid, t.txid)
  const at = (k) => t.inputs.findIndex((i) => `${i.txid}:${i.vout}` === k)
  assert.deepEqual(t.inputs[at(`${'b2'.repeat(32)}:1`)].witness, MAKER_WIT, 'the maker\'s witness')
  assert.equal(t.inputs[at(`${'f1'.repeat(32)}:0`)].witness.length, 2, 'the page\'s fee input, signed')
  assert.equal(t.inputs[at(`${'a2'.repeat(32)}:0`)].witness.length, 0, 'the enclave input goes to the policy server as signatures')
})

test('selling into a maker\'s buy quote: a coin the wallet signs but did not offer is refused before anything is sent', { skip: !have && 'pkg/ is absent' }, async () => {
  const w = await wallet()
  // The maker names the page's coin b3, unlisted when the trade is checked and listed (so signed) by the time the wallet signs.
  const { host, entry, cosigned, sent } = setup(w, { makerCoin: `${'b3'.repeat(32)}:0`, late: [`${'b3'.repeat(32)}:0`] })
  await assert.rejects(m.takeDvP(host, entry, { feeAsset: F }), /would sign input \d+, a coin not offered/)
  assert.equal(cosigned.length, 0)
  assert.ok(sent.some((x) => x.type === 'fail'))
})
