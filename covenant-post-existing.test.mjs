// postExisting: an order whose coin already rests on the chain (an offboard from
// leaves into the order's address) is posted to the relay only when that output
// pays the script the terms make, holds the sold asset in the clear, and holds
// exactly the order's amount. The offer it posts signs and verifies as the relay
// reads it.
//
// Run: node covenant-post-existing.test.mjs

import { planPlaceOrder, postExisting } from './covenant-order.js';
import { bytesToHex } from './covenant.js';
import * as seqob from './seqob.js';

let fails = 0;
function check(name, got, want){
  if (got !== want){ fails++; console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
}
async function refuses(name, p, re){
  try { await p; fails++; console.error(`FAIL ${name}: it was posted`); }
  catch (e){ if (re.test(e.message)) console.log(`ok   ${name}: ${e.message}`); else { fails++; console.error(`FAIL ${name}: ${e.message}`); } }
}
const rev = (h) => h.match(/../g).reverse().join('');

const assetA = bytesToHex(Uint8Array.from({length:32},(_,i)=>i));      // internal order
const assetB = bytesToHex(Uint8Array.from({length:32},(_,i)=>32+i));
const params = {
  assetA, assetB, sellAtoms: 600000n, rateNum: 2, rateDen: 1, minLot: 10000,
  expiryLocktime: 1792700673, makerProg: '11'.repeat(32), makerX: '22'.repeat(32),
};
const plan = planPlaceOrder(params);
const txid = 'ab'.repeat(32);
const priv = Uint8Array.from({length:32},(_,i)=>i+1);
const base = { ...params, txid, vout: 0, offerId: 'cd'.repeat(16), nowUnix: 1792600000, ttlSecs: 7200,
  makerPubkey: '02' + '00'.repeat(32) };
const output = (over) => async (t, v) => ({ scriptPubKey: plan.spkHex, asset: rev(assetA), value: '600000', ...over, _asked: [t, v] });

const posted = [];
const hooks = (over) => ({ fetchOutput: output(over), postCovenantOffer: async (o) => { const s = seqob.signOffer(o, priv); posted.push(s); return { ok: true }; } });

// The order is posted as it rests.
const r = await postExisting(base, hooks({}));
check('posted once', posted.length, 1);
const o = posted[0];
check('pair base is the sold asset, display order', o.pair.base_asset, rev(assetA));
check('pair quote is the wanted asset, display order', o.pair.quote_asset, rev(assetB));
check('offer_asset', o.offer_asset, rev(assetA));
check('offer amount is the coin\'s value', o.offer_amount, '600000');
check('want amount is the full price', o.want_amount, String(plan.requiredBForFull));
check('partial fills allowed', o.allow_partial, true);
check('covenant outpoint', o.covenant.covenant_txid + ':' + o.covenant.covenant_vout, txid + ':0');
check('terms keep internal ids', o.covenant.asset_a, assetA);
check('relay expiry', o.expires_at_unix, String(1792600000 + 7200));
check('the signed offer verifies', seqob.verifyOffer(JSON.parse(JSON.stringify(o))), true);
check('result carries the plan\'s script', r.plan.spkHex, plan.spkHex);

// Refused before anything is posted.
const before = posted.length;
await refuses('another script at the outpoint', postExisting(base, hooks({ scriptPubKey: '5120' + '00'.repeat(32) })), /reconstructed spk .* != on-chain spk/);
await refuses('another asset at the outpoint', postExisting(base, hooks({ asset: rev(assetB) })), /holds asset .* and the order sells/);
await refuses('a blinded output', postExisting(base, hooks({ asset: null, value: null })), /hides its asset or value/);
await refuses('one atom more than the order', postExisting(base, hooks({ value: '600001' })), /holds 600001, and the order sells 600000/);
await refuses('one atom less than the order', postExisting(base, hooks({ value: '599999' })), /holds 599999/);
await refuses('no output there', postExisting(base, { fetchOutput: async () => null, postCovenantOffer: async () => { posted.push(1); } }), /no output/);
await refuses('a bad txid', postExisting({ ...base, txid: 'zz' }, hooks({})), /txid must be 64 hex/);
await refuses('an amount the leaf cannot price', postExisting({ ...base, sellAtoms: 5n * 10n**18n, rateNum: 7, rateDen: 3 }, hooks({ value: String(5n * 10n**18n) })), /overflow/);
check('nothing posted on a refusal', posted.length, before);

if (fails){ console.error(`\n${fails} failed`); process.exit(1); }
console.log('\nall passed');
