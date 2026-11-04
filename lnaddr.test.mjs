// lnaddr.js: the name rules, the name key and its signatures, and the resolver a payment to
// `name@domain` goes through. Under node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME_WORDS, nameProblem, nameKey, signedDigest, signWith, verifySig, parseLnAddress, lnurlMetadata, resolveLnAddress, NAME_KEY_PATH } from './lnaddr.js';
import { decodeBolt11 } from './bolt11.js';
import { HDKey, mnemonicToSeedSync, schnorr } from './btc.js';
import { forbiddenIn } from './user-trade.js';

export const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

// A Bitcoin testnet invoice of `msat` (a multiple of 100), with a valid checksum and a zero
// signature: the readers never check the signature (bolt11.test.mjs builds them the same way).
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function toGroups (hex) { const out = []; let acc = 0, bits = 0; for (let i = 0; i < hex.length; i += 2) { acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function polymod (v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = (((c & 0x1ffffff) << 5) ^ x) >>> 0; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c = (c ^ G[i]) >>> 0; } return c; }
export function fakeInvoice (msat, { prefix = 'lntb', hash = '22'.repeat(32) } = {}) {
  const hrp = `${prefix}${BigInt(msat) / 100n}n`;
  const g = [0, 0, 0, 0, 0, 0, 0];
  const p = toGroups(hash);
  g.push(1, p.length >> 5, p.length & 31, ...p);
  for (let i = 0; i < 104; i++) g.push(0);
  const pre = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(pre.concat(g, [0, 0, 0, 0, 0, 0])) ^ 1;
  for (let i = 0; i < 6; i++) g.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + g.map((x) => CS[x]).join('');
}

test('the name rules', () => {
  for (const ok of ['abc', 'alice', 'a-b_c', '0123456789', 'x'.repeat(32)]) assert.equal(nameProblem(ok), null, ok);
  for (const bad of ['ab', 'x'.repeat(33), 'Alice', 'al.ice', 'al ice', 'é-tienne', '', null, 42, '-', 'a@b'])
    assert.match(String(nameProblem(bad)), /^A name has 3 to 32 characters/, String(bad));
});

test('the name key is the phrase\'s own, at its path', () => {
  const k = nameKey(PHRASE);
  assert.match(k.pub, /^[0-9a-f]{64}$/);
  assert.equal(nameKey('  ' + PHRASE.toUpperCase().replace(/ /g, '  ') + '\n').pub, k.pub, 'spacing and case do not change it');
  const direct = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive(NAME_KEY_PATH);
  assert.equal(Buffer.from(schnorr.getPublicKey(direct.privateKey)).toString('hex'), k.pub);
  assert.notEqual(nameKey(OTHER).pub, k.pub);
  assert.throws(() => nameKey(''), /no phrase/);
});

test('a signature means one action, one service, one name, one request', () => {
  const k = nameKey(PHRASE), o = nameKey(OTHER);
  const d = signedDigest('invoice', 'sequentiatestnet.com', 'alice', 'id1', 'lntb1…');
  const sig = signWith(k.priv, d);
  assert.equal(verifySig(k.pub, d, sig), true);
  assert.equal(verifySig(o.pub, d, sig), false, 'another key');
  for (const other of [
    signedDigest('code', 'sequentiatestnet.com', 'alice', 'id1', 'lntb1…'),
    signedDigest('invoice', 'example.com', 'alice', 'id1', 'lntb1…'),
    signedDigest('invoice', 'sequentiatestnet.com', 'alicf', 'id1', 'lntb1…'),
    signedDigest('invoice', 'sequentiatestnet.com', 'alice', 'id2', 'lntb1…'),
    signedDigest('invoice', 'sequentiatestnet.com', 'alice', 'id1', 'lntb2…'),
  ]) assert.equal(verifySig(k.pub, other, sig), false);
  // Fields can't be shifted across the separator.
  assert.notDeepEqual(signedDigest('wait', 'd', 'n', '1', '23'), signedDigest('wait', 'd', 'n', '12', '3'));
  assert.throws(() => signedDigest('code', 'd', 'n', 'a\nb'), /line break/);
  for (const junk of ['', 'zz', '00'.repeat(63), null]) assert.equal(verifySig(k.pub, d, junk), false);
  assert.equal(verifySig('nothex', d, sig), false);
});

test('reading a Lightning address', () => {
  assert.deepEqual(parseLnAddress('Alice@SequentiaTestnet.com'), { name: 'alice', domain: 'sequentiatestnet.com' });
  assert.deepEqual(parseLnAddress(' lightning:bob.smith+tip@wallet.example.org '), { name: 'bob.smith+tip', domain: 'wallet.example.org' });
  for (const no of ['alice', 'alice@', '@x.com', 'tb1qxyz', 'bitcoin:TB1Q?x=1', 'a@b', 'a b@c.com']) assert.equal(parseLnAddress(no), null, no);
  assert.deepEqual(JSON.parse(lnurlMetadata('alice', 'sequentiatestnet.com')),
    [['text/plain', 'Payment to alice@sequentiatestnet.com'], ['text/identifier', 'alice@sequentiatestnet.com']]);
});

// A fetch answering from a table of URL -> [status, body].
function table (rows, seen = []) {
  return async (url) => {
    seen.push(String(url));
    const hit = Object.entries(rows).find(([k]) => String(url).startsWith(k));
    if (!hit) throw new Error('offline');
    const [status, body] = hit[1];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}
const OURS = { domain: 'sequentiatestnet.com', base: 'https://sequentiatestnet.com/lsp', decode: decodeBolt11 };

test('a name of ours resolves to its receive code, for any asset', async () => {
  const seen = [];
  const fetch = table({ 'https://sequentiatestnet.com/lsp/lnaddr/alice': [200, { ok: true, code: 'bitcoin:TB1Q?ark=tark1x', fresh: true }] }, seen);
  for (const asset of ['BTC', 'ab'.repeat(32)]) {
    const r = await resolveLnAddress({ ...OURS, text: 'alice@sequentiatestnet.com', asset, fetch });
    assert.deepEqual(r, { code: 'bitcoin:TB1Q?ark=tark1x', fresh: true });
  }
  assert.deepEqual(seen, ['https://sequentiatestnet.com/lsp/lnaddr/alice', 'https://sequentiatestnet.com/lsp/lnaddr/alice']);
  const off = table({ 'https://sequentiatestnet.com/lsp/lnaddr/bob': [200, { status: 'ERROR', reason: "The recipient's wallet is offline. Try again when it is open." }] });
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@sequentiatestnet.com', asset: 'BTC', fetch: off }), /^Error: The recipient's wallet is offline/);
  const none = table({ 'https://sequentiatestnet.com/lsp/lnaddr/': [404, { status: 'ERROR', reason: 'No wallet goes by that name.' }] });
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'carol@sequentiatestnet.com', asset: 'BTC', fetch: none }), /No wallet goes by that name/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'a.b@sequentiatestnet.com', asset: 'BTC', fetch: none }), /No wallet goes by that name/, 'a name we never issue is not asked');
});

test('another service\'s address is paid in BTC over LNURL-pay, for exactly the amount', async () => {
  const pr = fakeInvoice(21_000n);
  const seen = [];
  const fetch = table({
    'https://wallet.example/.well-known/lnurlp/bob': [200, { tag: 'payRequest', callback: 'https://wallet.example/cb/bob?x=1', minSendable: 1000, maxSendable: 100_000_000, metadata: '[]' }],
    'https://wallet.example/cb/bob': [200, { pr, routes: [] }],
  }, seen);
  const r = await resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch });
  assert.deepEqual(r, { invoice: pr });
  assert.equal(seen[1], 'https://wallet.example/cb/bob?x=1&amount=21000');

  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'ab'.repeat(32), msat: 21_000n, fetch }), /takes BTC only/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', fetch }), /Enter an amount/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 500n, fetch }), /^Error: This address takes between 0\.00000001 and 0\.001 BTC\.$/);
  // The service answers an invoice for another amount, or on another chain: never paid.
  const wrong = (body) => table({
    'https://wallet.example/.well-known/lnurlp/bob': [200, { tag: 'payRequest', callback: 'https://wallet.example/cb/bob', minSendable: 1000, maxSendable: 100_000_000, metadata: '[]' }],
    'https://wallet.example/cb/bob': [200, body],
  });
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch: wrong({ pr: fakeInvoice(22_000n) }) }), /invoice for another amount/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch: wrong({ pr: fakeInvoice(21_000n, { prefix: 'lntsqt' }) }) }), /does not read|not for BTC/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch: wrong({ pr: 'garbage' }) }), /does not read/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch: wrong({ status: 'ERROR', reason: 'Not today.' }) }), /^Error: Not today\.$/);
  // A callback that is not https is not followed.
  const plain = table({ 'https://wallet.example/.well-known/lnurlp/bob': [200, { tag: 'payRequest', callback: 'http://wallet.example/cb', minSendable: 1000, maxSendable: 100_000_000, metadata: '[]' }] });
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@wallet.example', asset: 'BTC', msat: 21_000n, fetch: plain }), /does not take payments/);
  await assert.rejects(resolveLnAddress({ ...OURS, text: 'bob@nowhere.example', asset: 'BTC', msat: 21_000n, fetch: table({}) }), /could not be reached/);
});

test('default mode\'s words name no protocol', async () => {
  const shown = Object.entries(NAME_WORDS).filter(([k]) => !k.startsWith('dev')).map(([, v]) => v);
  shown.push(String(nameProblem('x')));
  for (const w of shown) assert.deepEqual(forbiddenIn(w), [], w);
  // The resolver's sentences, which Send shows.
  const said = [];
  const tries = [
    { text: 'bob@wallet.example', asset: 'ab'.repeat(32), msat: 1n },
    { text: 'bob@wallet.example', asset: 'BTC' },
    { text: 'bob@nowhere.example', asset: 'BTC', msat: 21_000n, fetch: table({}) },
  ];
  for (const t of tries) { try { await resolveLnAddress({ ...OURS, fetch: table({}), ...t }); } catch (e) { said.push(e.message); } }
  assert.equal(said.length, 3);
  for (const w of said) assert.deepEqual(forbiddenIn(w), [], w);
  assert.deepEqual(forbiddenIn(NAME_WORDS.devLabel), ['lightning'], 'the developer line is the one that names it');
});
