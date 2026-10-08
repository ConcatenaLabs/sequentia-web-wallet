// bolt11.js: the network, amount, payment hash, final CLTV and, on a Sequentia network, the asset
// (field `a`) the wallet reads from an invoice. Standalone (`node bolt11.test.mjs`) and under node --test.
import assert from 'node:assert';
import { decodeBolt11, bolt11Asset, bolt11AmountMsat, bolt11PaymentHash, bolt11MinFinalCltv } from './bolt11.js';

// An invoice SeqLN made on sequentia-regtest: 250,000,000 msat of the asset d024…efdb.
const SEQ_INV = 'lnsqrt2500u1p4vw55msp5ff8xy2dtczxuhsjctsn57f7f496jkz434hkp9jkq89rgem6zwnxspp53xx98drfa537svcqkhhhtl8tee729wsn20z86s32mmml9mdtgz3qdq2wejkxar0wgap56qj03x5pr8vyane3lj4us77ffc4h67txh3raldmtvgm7whedaldsxqyjw5qcqz959qxpqysgqhe48tu4zx3q0c0v0wfj23zndyyhw5m09npxgjs3v7etjm0kh3lhrxmj4ny0hkhsrw5xcd2jf76dacmfsshqykdcvyy4y37klh3x023cp8756dq';
const SEQ_HASH = '898c53b469ed23e83300b5ef75fcebce7ca2ba1353c47d422adef7f2edab40a2';
const SEQ_ASSET = 'd024f89a8119d84ecf31fcabc87bc94e2b7d7966bc47dfb76b6237e75f2defdb';
// The same network, made before invoices named their asset: the node refuses it now.
const SEQ_OLD = 'lnsqrt300m1p4vqc54sp55mylrq4dfn3cjs7zxjg0urxrpxxnzxhkdx7rdwefsf2m57elkk9qpp5z63d3a3qx6qs73qvuth2pvmz9khh3jy6um87fy9hueuxse8mlw8sdq9da6hgxqyjw5qcqz959qxpqysgqhk7a8uc3wl6vu0mgxc4d59q0y3qkfjpxqe3t06w5ks5caha8xsp8rrt3fqvj7favpmpge79amfserdywnsy8g3jkqe43a7jjx7wj6esq387l4s';
// BOLT 11's own example on Bitcoin mainnet.
const BTC_INV = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

// An invoice built here, with a valid checksum and a zero signature: the readers never check the signature.
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function toGroups(hex) { const out = []; let acc = 0, bits = 0; for (let i = 0; i < hex.length; i += 2) { acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = (((c & 0x1ffffff) << 5) ^ x) >>> 0; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c = (c ^ G[i]) >>> 0; } return c; }
function build(hrp, fields) {
  const g = [0, 0, 0, 0, 0, 0, 0];
  for (const [type, groups] of fields) g.push(type, groups.length >> 5, groups.length & 31, ...groups);
  for (let i = 0; i < 104; i++) g.push(0);
  const pre = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(pre.concat(g, [0, 0, 0, 0, 0, 0])) ^ 1;
  for (let i = 0; i < 6; i++) g.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + g.map((x) => CS[x]).join('');
}
const H = '11'.repeat(32), GOLD = 'ab'.repeat(31) + '01', SILV = 'cd'.repeat(32);

// The node's own invoice.
let d = decodeBolt11(SEQ_INV);
assert.deepStrictEqual(d, { ok: true, network: 'sequentia-regtest', chain: 'seq', asset: SEQ_ASSET,
  amountMsat: 250000000n, paymentHash: SEQ_HASH, minFinalCltv: d.minFinalCltv });
assert.ok(d.minFinalCltv > 18, 'a Sequentia invoice asks for its network final CLTV');
assert.equal(bolt11Asset(SEQ_INV), SEQ_ASSET);
assert.equal(bolt11Asset(' lightning:' + SEQ_INV.toUpperCase() + ' '), SEQ_ASSET, 'case, a URI scheme and spaces do not matter');
console.log('ok: the node\'s invoice reads as asset', SEQ_ASSET.slice(0, 8), 'amount', String(d.amountMsat), 'final CLTV', d.minFinalCltv);

// A Sequentia invoice without `a` is not one the node pays: refused, as the node refuses it.
d = decodeBolt11(SEQ_OLD);
assert.equal(d.ok, false);
assert.match(d.error, /^a: missing: an invoice on sequentia-regtest must name the asset it is paid in/);
assert.equal(bolt11Asset(SEQ_OLD), null);
assert.equal(bolt11PaymentHash(SEQ_OLD), '16a2d8f62036810f440ce2eea0b3622daf78c89ae6cfe490b7e6786864fbfb8f', 'its hash still reads');
console.log('ok: a Sequentia invoice naming no asset:', d.error);

// Every Sequentia prefix; the first `a` counts; a wrong length is refused.
for (const [p, net] of [['lnsqt', 'sequentia'], ['lntsqt', 'sequentia-testnet'], ['lnsqrt', 'sequentia-regtest']]) {
  d = decodeBolt11(build(p + '15u', [[1, toGroups(H)], [29, toGroups(GOLD)]]));
  assert.ok(d.ok && d.network === net && d.asset === GOLD && d.amountMsat === 1500000n && d.paymentHash === H, p);
}
assert.equal(decodeBolt11(build('lntsqt1m', [[1, toGroups(H)], [29, toGroups(SILV)], [29, toGroups(GOLD)]])).asset, SILV);
d = decodeBolt11(build('lntsqt1m', [[1, toGroups(H)], [29, toGroups(GOLD).slice(0, 51)]]));
assert.equal(d.ok, false); assert.equal(d.error, 'a: expected 52 characters, got 51');
console.log('ok: lnsqt, lntsqt and lnsqrt read their asset; the first `a` counts; 51 characters refused');

// Bitcoin: paid in bitcoin, `a` skipped as an unknown field.
d = decodeBolt11(BTC_INV);
assert.ok(d.ok && d.chain === 'btc' && d.network === 'bitcoin' && d.asset === null && d.amountMsat === 250000000n);
d = decodeBolt11(build('lntb5u', [[1, toGroups(H)], [29, toGroups(GOLD)]]));
assert.ok(d.ok && d.chain === 'btc' && d.asset === null && d.network === 'testnet');
assert.equal(bolt11Asset(BTC_INV), null);
console.log('ok: Bitcoin invoices carry no asset, with or without an `a` field');

// What is not an invoice the node would decode.
const flipped = SEQ_INV.slice(0, 60) + (SEQ_INV[60] === 'q' ? 'p' : 'q') + SEQ_INV.slice(61);
assert.match(decodeBolt11(flipped).error, /checksum/);
assert.equal(decodeBolt11(flipped, { checksum: false }).ok, true, 'the checksum is checked only when asked');
assert.match(decodeBolt11(build('lnxyz1m', [[1, toGroups(H)]])).error, /unknown network \(lnxyz1m\)/);
assert.match(decodeBolt11(build('lnbcrt1m', [])).error, /no payment hash/);
for (const x of ['', 'lnsqrt', 'notaninvoice', 42, null]) assert.equal(decodeBolt11(x).ok, false);
console.log('ok: a broken checksum, an unknown network, no hash and non-invoices are refused');

// The amount and CLTV readers, on the Sequentia prefixes too.
assert.equal(bolt11AmountMsat(SEQ_INV), 250000000n);
assert.equal(bolt11AmountMsat('lntsqt10u1p'), 1000000n);
assert.equal(bolt11AmountMsat('lnsqt3m1p'), 300000000n);
assert.equal(bolt11AmountMsat('lnsqrt1p'), null, 'an amountless invoice');
assert.equal(bolt11MinFinalCltv(build('lnsqrt1m', [[1, toGroups(H)], [29, toGroups(GOLD)]])), 18);
console.log('ok: amounts on lntsqt/lnsqt/lnsqrt; the CLTV default');
console.log('ALL PASS');
