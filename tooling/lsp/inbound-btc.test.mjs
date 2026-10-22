// Room to receive BTC: the same sale as in an asset, from the testnet4 LP (INBOUND_BTC_LP_RPC).
// A testnet4 output names no asset, so the LP's coins and a fee paid to it are read as the untagged
// coin; the channel is opened without `asset`; and a BTC channel may wait for a Bitcoin block
// before the user's node takes it, which is an opening channel, not a failure.
//
//   node --test tooling/lsp/inbound-btc.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { lpFreeAtoms, feePaidAtoms } from './inbound-limits.mjs';

// listfunds of a testnet4 node, as btc-maker answers it: no asset on any output.
const btcLp = { outputs: [
  { txid: 'aa'.repeat(32), output: 0, amount_msat: 23_917_000, status: 'confirmed', reserved: false },
  { txid: 'bb'.repeat(32), output: 1, amount_msat: 210_000_000_000, status: 'confirmed', reserved: false },
  { txid: 'cc'.repeat(32), output: 0, amount_msat: 5_000_000_000, status: 'unconfirmed', reserved: false },
  { txid: 'dd'.repeat(32), output: 0, amount_msat: 7_000_000_000, status: 'confirmed', reserved: true },
  { txid: 'ee'.repeat(32), output: 2, amount_msat: 3_000_000, status: 'spent' },
] };

test('the BTC LP\'s free coins are its confirmed, unreserved outputs, none of which names an asset', () => {
  assert.equal(lpFreeAtoms(btcLp, '', ''), 23_917 + 210_000_000);
});

test('a fee paid in BTC is read from the LP\'s outputs of that transaction, spent or not', () => {
  assert.equal(feePaidAtoms(btcLp, 'ee'.repeat(32), '', ''), 3_000);
  assert.equal(feePaidAtoms(btcLp, 'EE'.repeat(32), '', ''), 3_000, 'a txid in any case');
  assert.equal(feePaidAtoms(btcLp, 'ff'.repeat(32), '', ''), 0, 'a payment it does not hold is not paid');
  // An asset LP's output of the same txid is not a BTC fee.
  assert.equal(feePaidAtoms({ outputs: [{ txid: 'ee'.repeat(32), amount_msat: 3_000_000, asset: '1f'.repeat(32) }] }, 'ee'.repeat(32), '', ''), 0);
});

const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const i = src.indexOf(from); assert.ok(i > 0, from); return src.slice(i, src.indexOf(to, i)); };

test('BTC is sold from the testnet4 LP, under the id the BTC nodes already peer with', () => {
  assert.match(src, /inboundBtcLpRpc: process\.env\.INBOUND_BTC_LP_RPC \|\| '',/);
  const lp = between('async function inboundLp(', '\n}\n');
  assert.match(lp, /if \(assetId === 'BTC'\)/);
  assert.match(lp, /rpc: CFG\.inboundBtcLpRpc, lpId: \(CFG\.channelPeerBtcProvisioned \|\| ''\)\.split\('@'\)\[0\],\s*coin: '', policy: '', chain: 'btc'/);
  // Every step of the sale goes through it: the address, the stock, the fee, the room there, the open.
  for (const fn of ['async function inboundFeeAddress(', 'async function inboundFundingProblem(', 'async function verifyInboundFeePaid(',
    'async function inboundRoomThere(', 'async function provisionInbound(']) {
    assert.match(between(fn, '\n}\n'), /await inboundLp\(assetId\)/, fn);
  }
  assert.doesNotMatch(between('async function verifyInboundFeePaid(', '\n}\n'), /CFG\.subasLpRpc/);
  assert.doesNotMatch(between('async function provisionInbound(', '\n}\n'), /CFG\.subasLpRpc/);
});

test('the BTC channel is opened without an asset, toward a BTC node only, and an unconfirmed one is opening', () => {
  const prov = between('async function provisionInbound(', '\n}\n');
  assert.match(prov, /\.\.\.\(lp\.isBtc \? \[\] : \[`asset=\$\{assetId\}`\]\)/);
  assert.match(prov, /targetFor\(lp\.chain, lp\.isBtc \? null : assetId, nodeKey\)/);
  assert.match(prov, /if \(rec\.chain && rec\.chain !== lp\.chain\) throw/);
  assert.match(prov, /if \(lp\.isBtc && chan && \/AWAITING_LOCKIN\/\.test\(String\(chan\.state \|\| ''\)\)\) \{\s*return \{ ok: true, already_had_inbound: false, pending: true,/);
});

test('the purchase takes BTC, priced in sat, and refuses it where it is not sold', () => {
  const post = between("url.pathname === '/channel/inbound')", "url.pathname === '/channel/close'");
  assert.match(post, /const isBtc = \/\^btc\$\/i\.test\(String\(body\.asset \|\| ''\)\);/);
  assert.match(post, /const assetId = isBtc \? 'BTC' : resolveAsset\(body\.asset\);/);
  assert.match(post, /if \(isBtc && !CFG\.inboundBtcLpRpc\) return send\(res, 400,/);
  assert.match(post, /const lim = isBtc \? \{\} : await inboundLimitsFor\(assetId\);/);
  assert.match(post, /quoteInboundFee\(amount, \{ isBtc, assetId, months, \.\.\.lim \}\)/);
  const quote = between("url.pathname === '/channel/inbound/quote'", "url.pathname === '/channel/inbound')");
  assert.match(quote, /const assetId = isBtc \? 'BTC' : resolveAsset\(rawAsset\);/);
  assert.match(src, /btc_room: !!\(CFG\.inboundBtcLpRpc && CFG\.channelPeerBtcProvisioned\),/);
});

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fnSrc = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('the wallet offers room to receive BTC where the service sells it, with no channel of its own first', () => {
  const step = fnSrc('lnStepFor');
  assert.match(step, /if\(receive\) return \(lnLastStatus\.funding && lnLastStatus\.funding\.btc_room\)\s*\? \{ label:'Add room to receive', go:\(\)=>lnReceiveRoomDialog\(\{ chain:'btc', asset:'BTC', ticker:'BTC', precision:8,/);
  assert.match(fnSrc('lnBtcRoomSold'), /lnLastStatus\.funding\.btc_room/);
});

test('the purchase connects the BTC node, pays the fee on testnet4, and waits for a Bitcoin block', () => {
  const dlg = fnSrc('lnReceiveRoomDialog');
  assert.match(dlg, /const prov = leg\.chain==='btc'\s*\? await provisionAndConnect\(\{ chain:'btc', label:'BTC'/);
  assert.match(dlg, /lnSendDeposit\(\{ chain: leg\.chain==='btc' \? 'btc' : 'seq', asset: leg\.asset, amount: due, address: q\.pay_to \}\)/);
  assert.match(dlg, /const have=lnLegHeld\(leg\);/);
  const claim = fnSrc('lnClaimInbound');
  assert.match(claim, /const btc = rec\.asset==='BTC', waitMin = btc \? 45 : 8;/);
  assert.match(claim, /throw new Error\('the service has not seen your fee payment after '\+waitMin\+' minutes'\);/);
  assert.match(fnSrc('lnPaintRecvRoom'), /const when=hex==='BTC' \? 'once a Bitcoin block confirms it' : 'in about a minute';/);
});
