// A cooperative close of the wallet's own channel pays a receive address of the device that asked
// for it, and that device remembers the address only in its own browser. Every other device of the
// same wallet must still sign that close: each signer is told the wallet's own receive scripts,
// derived from its phrase, when it is built. Without them the node, which asks for the close's
// signature at each start, never started again on any other device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSeqln, setOwnCloseScripts, connectProvisioned, connectDevice, disconnectDevice, disconnectProvisioned } from './seqln.js';

const built = [];
class SeqlnSigner {
  static async fromMnemonic(seed){ const s = new SeqlnSigner(); s.approved = []; built.push(s); return s; }
  setPolicy(){ return this; }
  approveCloseDestination(hex){ this.approved.push(hex); }
  async connect({ deviceStaticPrivkey }){ this._id = 'node-' + String(deviceStaticPrivkey).slice(0, 8); }
  async whenNodeId(){ return this._id; }
  disconnect(){}
}
initSeqln({ sdk: { SeqlnSigner } });

const OWN = ['0014' + 'AB'.repeat(20), '0014' + 'cd'.repeat(20)];

test('a provisioned node\'s signer is told the wallet\'s own receive scripts', async () => {
  setOwnCloseScripts(() => OWN);
  built.length = 0;
  const id = await connectProvisioned({ key: 'btc:02' + '11'.repeat(32), deviceSigningSeed: 'seed', deviceTransportPrivkey: 'aa'.repeat(32), wsUrl: 'wss://x/n', hostStaticPubkey: '02' + '22'.repeat(32) });
  assert.ok(id);
  assert.deepEqual(built[0].approved, OWN.map(h => h.toLowerCase()));
  disconnectProvisioned('btc:02' + '11'.repeat(32));
});

test('the fixed nodes\' signers are told them too', async () => {
  setOwnCloseScripts(() => OWN);
  built.length = 0;
  const id = await connectDevice({ node: 'btc', deviceSigningSeed: 'seed', deviceTransportPrivkey: 'bb'.repeat(32), wsUrl: 'wss://x/b', hostStaticPubkey: '02' + '33'.repeat(32) });
  assert.ok(id);
  assert.deepEqual(built[0].approved, OWN.map(h => h.toLowerCase()));
  disconnectDevice('btc');
});

test('a provider that throws, or none, names nothing and builds the signer all the same', async () => {
  setOwnCloseScripts(() => { throw new Error('wallet locked'); });
  built.length = 0;
  assert.ok(await connectProvisioned({ key: 'btc:02' + '44'.repeat(32), deviceSigningSeed: 's', deviceTransportPrivkey: 'cc'.repeat(32), wsUrl: 'wss://x/c', hostStaticPubkey: '02' + '55'.repeat(32) }));
  assert.deepEqual(built[0].approved, []);
  disconnectProvisioned('btc:02' + '44'.repeat(32));
  setOwnCloseScripts(null);
});

test('the page names the same receive chain a close pays, from the first address on', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const dest = html.slice(html.indexOf('async function lnWalletCloseDestination'), html.indexOf('async function lnWalletCloseDestination') + 400);
  assert.match(dest, /btc\.p2wpkh\(btcNode\(false, unifiedNextUnused\(\)\)\.publicKey/, 'a close pays the next unused receive address');
  const own = html.slice(html.indexOf('function ownCloseScripts'), html.indexOf('function ownCloseScripts') + 700);
  assert.match(own, /next \+ OWN_CLOSE_SCRIPTS_PAST/, 'well past the next unused one');
  assert.match(own, /btc\.p2wpkh\(btcNode\(false, i\)\.publicKey, btc\.TEST_NETWORK\)\.script/, 'the same receive chain and script');
  assert.match(html, /\r?\nsetOwnCloseScripts\(ownCloseScripts\);/, 'handed to every signer');
});
