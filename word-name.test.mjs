// word-name.js: the word list, a key's candidates in their order, how a name is shown, and, over
// the name service, a third word only when two are taken and a restore that gets the same name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORDS, CANDIDATES, wordNameCandidates, wordsOf, displayName } from './word-name.js';
import { nameKey, nameProblem, mountLnAddress, signWith, signedDigest } from './lnaddr.js';
import { makeLnaddr } from './tooling/lsp/lnaddr.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const DOMAIN = 'sequentiatestnet.com';

test('the list: 831 words of letters, each once, as published here', () => {
  assert.equal(WORDS.length, 831);
  assert.ok(WORDS.every((w) => /^[a-z]{3,5}$/.test(w)));
  assert.equal(new Set(WORDS).size, WORDS.length);
  // The EFF short wordlist 1 less the BIP39 English words and yo-yo, checked once against both lists
  // when it was made: any change to it shows here.
  assert.equal(crypto.createHash('sha256').update(WORDS.join('\n')).digest('hex'), 'fb2954dccc87b4db6399683028b284a1a04fb326f505a267b39ca74827b7f5c7');
});

test('a key\'s candidates: two words, then three, each a valid name, always the same', () => {
  for (let i = 0; i < 300; i++) {
    const pub = crypto.randomBytes(32).toString('hex');
    const c = wordNameCandidates(pub);
    assert.equal(c.length, CANDIDATES);
    assert.equal(c[0].words.length, 2);
    for (const x of c.slice(1)) assert.equal(x.words.length, 3);
    for (const x of c) {
      assert.equal(new Set(x.words).size, x.words.length, 'no word twice');
      assert.equal(x.name, x.words.join(''));
      assert.equal(nameProblem(x.name), null, x.name);
      assert.ok(x.name.length <= 15);
    }
    assert.deepEqual(wordNameCandidates(pub.toUpperCase()), c, 'the same for the same key');
  }
  const a = wordNameCandidates(nameKey(PHRASE).pub), b = wordNameCandidates(nameKey(OTHER).pub);
  assert.notEqual(a[0].name, b[0].name);
});

test('shown with capitals; the name itself stays lower case', () => {
  const pub = nameKey(PHRASE).pub, [first, second] = wordNameCandidates(pub);
  assert.equal(displayName(first.name, pub), first.words.map((w) => w[0].toUpperCase() + w.slice(1)).join(''));
  assert.equal(displayName(second.name.toUpperCase(), pub), second.words.map((w) => w[0].toUpperCase() + w.slice(1)).join(''), 'typed in capitals: the same words');
  assert.deepEqual(wordsOf(first.name, pub), first.words);
  assert.equal(wordsOf(first.name, nameKey(OTHER).pub), null, 'another key\'s');
  assert.equal(displayName('alice', pub), 'alice', 'a name of another kind is shown as it is');
  assert.equal(displayName(first.name, null), first.name);
});

async function serveAt (dir) {
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = makeLnaddr({ domain: DOMAIN, base, storePath: path.join(dir, 'names.json'), holdMs: 300, waitMs: 500 });
  server.on('request', async (req, res) => { if (await svc.handle(req, res, new URL(req.url, 'http://x'))) return; res.writeHead(404); res.end('{}'); });
  return { base, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}
function wallet (base, phrase, store = new Map()) {
  const k = nameKey(phrase);
  return mountLnAddress({ base, domain: DOMAIN, key: () => k, invoice: async () => { throw new Error('no'); }, code: async () => { throw new Error('no'); },
    limits: () => null, store: { get: (x) => store.get(x) ?? null, set: (x, v) => (v == null ? store.delete(x) : store.set(x, v)) }, retryMs: 100 });
}

test('over the service: a third word only when two are taken; a restore gets the same name back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordname-'));
  let s = await serveAt(dir);
  const mine = wordNameCandidates(nameKey(PHRASE).pub);
  try {
    // Another wallet holds this wallet's two-word name already, written in capitals.
    const o = nameKey(OTHER), t = Math.floor(Date.now() / 1000);
    const r = await fetch(`${s.base}/lnaddr/-/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: mine[0].name, pubkey: o.pub, ts: t, sig: signWith(o.priv, signedDigest('register', DOMAIN, mine[0].name, o.pub, t)) }) });
    assert.equal(r.status, 200);
    const w = wallet(s.base, PHRASE);
    assert.equal(await w.claimWordName(), mine[1].name, 'the next candidate: three words');
    assert.equal(w.display(), mine[1].words.map((x) => x[0].toUpperCase() + x.slice(1)).join('') + '@' + DOMAIN);
    assert.equal(w.isWordName(), true);
    w.stop();
    // Restored from the phrase alone, elsewhere: the same name, shown the same.
    const again = wallet(s.base, PHRASE);
    assert.equal(await again.recover(), mine[1].name);
    assert.equal(again.display(), w.display());
    again.stop();
    // The service lost its record: the wallet gets the same name again, since the other still
    // holds the first.
    await s.close(); fs.rmSync(path.join(dir, 'names.json'));
    s = await serveAt(dir);
    const r2 = await fetch(`${s.base}/lnaddr/-/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: mine[0].name, pubkey: o.pub, ts: t, sig: signWith(o.priv, signedDigest('register', DOMAIN, mine[0].name, o.pub, t)) }) });
    assert.equal(r2.status, 200);
    const fresh = wallet(s.base, PHRASE);
    assert.equal(await fresh.recover(), null);
    assert.equal(await fresh.claimWordName(), mine[1].name);
    fresh.stop();
    // A wallet holding a name of its own kind takes its word name in one step, and the old name is free.
    const c = wallet(s.base, OTHER);
    await c.register('my-own-name');
    assert.equal(c.isWordName(), false);
    const cw = await c.claimWordName();
    assert.equal(cw, wordNameCandidates(o.pub)[0].name, 'its own two-word name (its first name was released by my-own-name)');
    assert.equal((await fetch(`${s.base}/lnaddr/-/mine?pubkey=${o.pub}`).then((x) => x.json())).name, cw);
    c.stop();
    // Lookups ignore case: the capitals a person reads pay the same wallet.
    const up = await fetch(`${s.base}/.well-known/lnurlp/${mine[1].words.map((x) => x[0].toUpperCase() + x.slice(1)).join('')}`);
    assert.notEqual(up.status, 404);
  } finally { await s.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('joined names that read the same are one name at the service', () => {
  // Among many keys' two-word names, any two from different words that join to the same string are
  // the same key at the service (it keys names by the joined lower-case string), so they can never
  // both be held. Counted here, for the record.
  const seen = new Map(); let same = 0;
  for (let i = 0; i < 20000; i++) {
    const c = wordNameCandidates(crypto.randomBytes(32).toString('hex'), 1)[0];
    const had = seen.get(c.name);
    if (had && had !== c.words.join(' ')) same++;
    seen.set(c.name, c.words.join(' '));
  }
  console.log(`  20,000 two-word names: ${seen.size} distinct, ${same} reading the same from other words`);
  assert.ok(seen.size > 19000);
});
