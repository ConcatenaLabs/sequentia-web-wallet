// The regtest stack the interactive-maker drive (interactive-maker-drive.mjs) runs against: a
// Sequentia chain anchored to a regtest parent (both run by one sequentiad binary), two issued
// assets the node takes fees in, an esplora shim over the node, SeqDEX's relay (seqobd) watching
// it, and a live interactive maker: SeqDEX's wallet daemon (oceand) holding its coins and its
// order-book maker (seqob-maker -mode samechain) resting a signed offer and co-signing each lift
// over the relay's courier, as the testnet's makers do. `startBackends` puts this checkout and
// every endpoint the page calls behind one origin. The same chain and maker as the browser
// extension's test/market/chain.mjs and test/market/maker.mjs. Node only; nothing here is used by
// the deployed wallet.
//
//   const c = await startChain({ sequentiad, seqobd, work, log, nodeArgs: ['-blockfilterindex=1'] })
//   const m = await startInteractiveMaker({ chain: c, oceand, seqobMaker, seqobOctl, work, give, want, env, log })
//   const b = await startBackends({ chain: c, assets, prices })
//
// The maker sells `give` for `want` (side sell, base = give.asset), funded with explicit coins;
// `env` goes into its environment. The wallet daemon speaks SeqDEX's own regtest network (bech32
// and blech32 "bcrt"), the chain its own (elementsregtest, "ert"), so the daemon's confidential
// address is funded at the explicit address of its script (`explicitAddress`). Every process is a
// child of the caller, stopped by its PID in each `stop()`; every file lives under `work`.
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rpcCall, startEsploraShim } from './esplora-shim.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const COIN = 100000000;

export async function startChain({ sequentiad, seqobd, work, log = () => {}, nodeArgs = [] }) {
  fs.mkdirSync(path.join(work, 'parent'), { recursive: true });
  fs.mkdirSync(path.join(work, 'node'), { recursive: true });
  const procs = [];
  const parentPort = await freePort();
  const parent = spawn(sequentiad, [`-datadir=${path.join(work, 'parent')}`, '-chain=regtest', `-rpcport=${parentPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet'], { stdio: 'ignore' });
  procs.push(parent);
  const pcall = (m, p = []) => rpcCall({ url: `http://127.0.0.1:${parentPort}/`, auth: 'u:p' }, m, p);
  for (let i = 0; ; i++) { try { await pcall('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  const burn = (await pcall('getdescriptorinfo', ['raw(51)'])).descriptor;
  await pcall('generatetodescriptor', [5, burn]);
  const rpcPort = await freePort();
  const node = spawn(sequentiad, [`-datadir=${path.join(work, 'node')}`, '-chain=elementsregtest', '-con_bitcoin_anchor=1', '-validateanchor=1', '-mainchainrpchost=127.0.0.1',
    `-mainchainrpcport=${parentPort}`, '-mainchainrpcuser=u', '-mainchainrpcpassword=p', '-parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
    '-anchorpollinterval=1', '-anchorminconf=1', `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-txindex=1', '-par=1', '-evbparams=simplicity:-1:::', '-initialfreecoins=2100000000000000',
    '-anyonecanspendaremine=1', '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-validatepegin=0', '-con_parent_chain_signblockscript=51',
    '-con_any_asset_fees=1', '-fallbackfee=0.0001', '-maxtxfee=100', ...nodeArgs], { stdio: 'ignore' });
  procs.push(node);
  const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
  const call = (m, p = []) => rpcCall(rpc, m, p);
  const wcall = (m, p = []) => rpcCall({ ...rpc, url: rpc.url + 'wallet/bank' }, m, p);
  for (let i = 0; ; i++) { try { await call('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  await sleep(2000);   // the anchor watcher's first look at the parent
  await call('createwallet', ['bank']);
  const mine = async (n = 1) => call('generatetoaddress', [n, await wcall('getnewaddress')]);
  await mine(101); await wcall('rescanblockchain');
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  const issue = async (n) => { const a = (await wcall('issueasset', { assetamount: n, tokenamount: 0, blind: false, fee_asset: 'bitcoin' })).asset; await mine(1); return a; };
  const X = await issue(1000), Y = await issue(10000000);
  const rates = await call('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN;
  await call('setfeeexchangerates', [rates]);
  log(`chain: policy ${policy}, X ${X}, Y ${Y}, node pid ${node.pid}, parent pid ${parent.pid}`);

  const shim = await startEsploraShim({ rpc, port: await freePort() });
  const relayPort = await freePort();
  const relayLog = fs.openSync(path.join(work, 'seqobd.log'), 'a');
  const relay = spawn(seqobd, [`-listen=127.0.0.1:${relayPort}`, `-node-rpc=127.0.0.1:${rpcPort}`, '-node-rpc-user=u', '-node-rpc-pass=p',
    '-watch-interval=1s', '-min-expiry=5s', '-fill-anchor-depth=2'], { stdio: ['ignore', relayLog, relayLog] });
  procs.push(relay);
  const R = `http://127.0.0.1:${relayPort}`;
  for (let i = 0; ; i++) { try { if ((await fetch(R + '/v1/markets')).ok) break; } catch (e) { if (i > 150) throw e; } await sleep(200); }
  log(`relay seqobd pid ${relay.pid} at ${R}`);

  // Bury: parent blocks over the chain's anchor, so the relay can call a fill final. The
  // chain anchors each new block to the parent tip; burying means parent blocks past
  // the anchor, then a block that reads the new tip.
  const bury = async (n = 3) => {
    for (let i = 0; i < n; i++) { await pcall('generatetodescriptor', [1, burn]); await sleep(1200); await mine(1); }
  };
  const fund = async (address, asset, amount) => wcall('sendtoaddress', { address, amount, assetlabel: asset, fee_asset_label: 'bitcoin' });
  const advance = async (secs) => {
    const t = (await call('getblockheader', [await call('getbestblockhash')])).time;
    await call('setmocktime', [t + secs + 60]); await mine(12);
  };
  const stop = async () => {
    try { await shim.close(); } catch {}
    if (relay.exitCode == null) { relay.kill('SIGTERM'); await new Promise((r) => (relay.exitCode != null ? r() : relay.once('exit', r))); }
    try { await call('stop'); } catch {}
    if (node.exitCode == null) await new Promise((r) => node.once('exit', r));
    try { await pcall('stop'); } catch {}
    if (parent.exitCode == null) await new Promise((r) => parent.once('exit', r));
  };
  return { rpc, call, wcall, pcall, mine, bury, fund, advance, policy, genesis, X, Y, shim, relay: R, relayPid: relay.pid, nodePid: node.pid, parentPid: parent.pid, stop };
}

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 20000 }, (e, stdout, stderr) => (e ? reject(new Error(String(stderr || e.message).trim())) : resolve(String(stdout))));
});

// ---- bech32 / bech32m, enough to move an address between prefixes ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [];
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); } }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
function encode(hrp, words, bech32m) {
  const chk = polymod(hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0])) ^ (bech32m ? 0x2bc830a3 : 1);
  return hrp + '1' + words.concat([0, 1, 2, 3, 4, 5].map((i) => (chk >>> (5 * (5 - i))) & 31)).map((d) => CHARSET[d]).join('');
}
// The explicit address, under `hrp`, of a segwit address's script: a bech32 address is
// re-prefixed; a blech32 (confidential) one, whose data is the witness version, a 33-byte
// blinding key and the program under a 12-character checksum, loses its key.
export function explicitAddress(address, hrp) {
  const a = address.toLowerCase();
  const words = [...a.slice(a.lastIndexOf('1') + 1)].map((c) => CHARSET.indexOf(c));
  if (words.some((d) => d < 0)) throw new Error('not a bech32 address: ' + address);
  if (words.length < 80) return rehrp(address, hrp);
  const program = convertBits(words.slice(1, -12), 5, 8, false).slice(33);
  if (program.length !== 20 && program.length !== 32) throw new Error('not a blech32 segwit address: ' + address);
  return encode(hrp, [words[0], ...convertBits(program, 8, 5, true)], words[0] !== 0);
}
export function rehrp(address, hrp) {
  const a = address.toLowerCase();
  const sep = a.lastIndexOf('1');
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error('not a bech32 address: ' + address);
  const const_ = polymod(hrpExpand(a.slice(0, sep)).concat(data));
  if (const_ !== 1 && const_ !== 0x2bc830a3) throw new Error('bad bech32 checksum: ' + address);
  const payload = data.slice(0, -6);
  const chk = polymod(hrpExpand(hrp).concat(payload, [0, 0, 0, 0, 0, 0])) ^ const_;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + '1' + payload.concat(sum).map((d) => CHARSET[d]).join('');
}

// A public test phrase, never funded anywhere but a local chain.
const MAKER_PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

export async function startInteractiveMaker({ chain, oceand, seqobMaker, seqobOctl, work, give, want, fund = [], extraArgs = [], env = {}, name = 'maker', mnemonic = MAKER_PHRASE, log = () => {} }) {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, 'ocean'), { recursive: true });
  const procs = [];
  const nodeUrl = new URL(chain.rpc.url);
  const nodeRpc = `http://${chain.rpc.auth}@${nodeUrl.host}`;
  const oceanPort = await freePort();
  const ocean = `127.0.0.1:${oceanPort}`;
  const oceanLog = fs.openSync(path.join(dir, 'oceand.log'), 'a');
  const od = spawn(oceand, [], {
    env: { ...process.env,
      OCEAN_NETWORK: 'sequentia-regtest', OCEAN_NATIVE_ASSET: chain.policy, OCEAN_NODE_RPC_ADDR: nodeRpc,
      OCEAN_BLOCKCHAIN_SCANNER_TYPE: 'elements', OCEAN_DB_TYPE: 'badger', OCEAN_NO_TLS: 'true', OCEAN_NO_PROFILER: 'true',
      OCEAN_DATADIR: path.join(dir, 'ocean'), OCEAN_PORT: String(oceanPort), OCEAN_LOG_LEVEL: '4',
      OCEAN_MNEMONIC: mnemonic, OCEAN_PASSWORD: randomBytes(12).toString('hex') },
    stdio: ['ignore', oceanLog, oceanLog] });
  procs.push(od);
  log(`${name}: oceand pid ${od.pid} at ${ocean}`);

  // The account, once the daemon has made and unlocked its wallet.
  let address = null;
  const deadline = (s) => Date.now() + s * 1000;
  for (const until = deadline(90); !address && Date.now() < until;) {
    try {
      const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'create']);
      address = (out.match(/address\[mm\] (\S+)/) || [])[1] || null;
    } catch (e) {
      if (/already exists/.test(e.message)) {
        const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'address']);
        address = (out.match(/address\[mm\] (\S+)/) || [])[1] || null;
      } else await sleep(400);
    }
  }
  if (!address) throw new Error(`${name}: oceand never made its account (see ${path.join(dir, 'oceand.log')})`);
  const chainAddress = explicitAddress(address, 'ert');
  log(`${name}: account mm, address ${address} (${chainAddress} on the chain)`);

  // Its coins: what it sells, and whatever else the drive asks for.
  const units = (atoms) => Number(atoms) / 1e8;
  await chain.fund(chainAddress, give.asset, units(BigInt(give.atoms) * 2n));
  for (const f of fund) await chain.fund(chainAddress, f.asset, f.amount);
  await chain.mine(1);
  const balance = async () => {
    const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'balance']);
    const b = {};
    for (const m of out.matchAll(/balance\[mm\] ([0-9a-f]{64}) confirmed=(\d+) unconfirmed=(\d+) locked=(\d+) total=(\d+)/g)) b[m[1]] = { confirmed: BigInt(m[2]), unconfirmed: BigInt(m[3]), locked: BigInt(m[4]), total: BigInt(m[5]) };
    return b;
  };
  for (const until = deadline(90); ;) {
    const b = await balance().catch(() => ({}));
    if (b[give.asset] && b[give.asset].confirmed >= BigInt(give.atoms)) break;
    if (Date.now() > until) throw new Error(`${name}: oceand never saw its funding (see ${path.join(dir, 'oceand.log')})`);
    await sleep(500);
  }

  // The maker, resting its offer on the chain's relay.
  const makerKey = randomBytes(32).toString('hex');
  const makerLog = fs.openSync(path.join(dir, 'seqob-maker.log'), 'a');
  const mk = spawn(seqobMaker, ['-mode', 'samechain', '-relay', chain.relay, '-ocean', ocean, '-account', 'mm',
    '-base', give.asset, '-quote', want.asset, '-side', 'sell', '-base-amount', String(give.atoms), '-quote-amount', String(want.atoms),
    '-min-anchor-depth', '0', '-expiry', '1h', ...extraArgs],
  { env: { ...process.env, ...env, SEQOB_MAKER_PRIV: makerKey, SEQOB_NODE_RPC: nodeRpc }, stdio: ['ignore', makerLog, makerLog] });
  procs.push(mk);
  log(`${name}: seqob-maker pid ${mk.pid}`);
  let offer = null;
  for (const until = deadline(90); !offer && Date.now() < until;) {
    if (mk.exitCode != null) throw new Error(`${name}: seqob-maker exited ${mk.exitCode} (see ${path.join(dir, 'seqob-maker.log')})`);
    try {
      const j = await (await fetch(`${chain.relay}/v1/market/${give.asset}/${want.asset}/orderbook`)).json();
      offer = (j.offers || []).find((o) => !o.covenant && o.same_chain && o.offer_asset === give.asset) || null;
    } catch {}
    if (!offer) await sleep(300);
  }
  if (!offer) throw new Error(`${name}: the offer never reached the relay (see ${path.join(dir, 'seqob-maker.log')})`);
  log(`${name}: offer ${offer.offer_id} gives ${offer.offer_amount} for ${offer.want_amount}, receive address ${offer.same_chain.maker_recv_address}`);

  const stop = async () => {
    for (const p of [mk, od]) {
      if (p.exitCode == null && p.signalCode == null) {
        p.kill('SIGTERM');
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 20000);
        await new Promise((r) => (p.exitCode != null || p.signalCode != null ? r() : p.once('exit', r)));
        clearTimeout(t);
      }
    }
  };
  return { ocean, address, chainAddress, offer, balance, stop, pids: { oceand: od.pid, maker: mk.pid }, logs: { ocean: path.join(dir, 'oceand.log'), maker: path.join(dir, 'seqob-maker.log') } };
}

// This checkout and the page's backends behind one origin, every endpoint at the path the box
// serves it at: /api/… (the esplora shim), /seqob/… (the relay, its courier websocket included),
// /feerates (the node's fee exchange rates), /prices, /registry/index.minimal.json (the drive's
// assets: { id: [ticker, name, precision] }). The other books answer empty; anything else 404s.
export function startBackends ({ chain, assets = {}, prices = {} }) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const body = (req) => new Promise((ok, no) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => ok(Buffer.concat(p))); req.on('error', no) })
  const log = []
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname)
    log.push(`${req.method} ${p}`)
    const send = (code, data, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(data) }
    const proxy = async (target) => {
      const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req)
      try {
        const r = await fetch(target, { method: req.method, headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}, body: b })
        send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json')
      } catch (e) { send(502, 'could not reach ' + target + ': ' + e.message, 'text/plain') }
    }
    try {
      if (p.startsWith('/api/')) return proxy(chain.shim.url + p + url.search)
      if (p.startsWith('/seqob/')) return proxy(chain.relay + p.slice('/seqob'.length) + url.search)
      if (/^\/seqob-[a-z]+\//.test(p)) {
        if (p.endsWith('/v1/markets')) return send(200, JSON.stringify({ markets: [] }))
        if (p.endsWith('/orderbook')) return send(200, JSON.stringify({ offers: [] }))
        return send(404, 'not served here', 'text/plain')
      }
      if (p === '/feerates') return send(200, JSON.stringify(await chain.call('getfeeexchangerates')))
      if (p === '/prices') return send(200, JSON.stringify(prices))
      if (p === '/registry/index.minimal.json') {
        const idx = {}
        for (const [id, [ticker, name, precision]] of Object.entries(assets)) idx[id] = ['regtest.invalid', ticker, name, precision, true, false]
        return send(200, JSON.stringify(idx))
      }
    } catch (e) { return send(500, String(e.message), 'text/plain') }
    if (p.endsWith('/')) p += 'index.html'
    const f = path.join(ROOT, p)
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, 'not found', 'text/plain')
    send(200, fs.readFileSync(f), types[path.extname(f)] || 'application/octet-stream')
  })
  // The relay's courier is a websocket: the upgrade is passed through to it byte for byte.
  const sockets = new Set()
  srv.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith('/seqob/')) { socket.destroy(); return }
    const r = new URL(chain.relay)
    const up = net.connect(Number(r.port), r.hostname, () => {
      const hdrs = Object.entries(req.headers).filter(([k]) => k !== 'host').map(([k, v]) => `${k}: ${v}`)
      up.write(`${req.method} ${url.pathname.slice('/seqob'.length)}${url.search} HTTP/1.1\r\nhost: ${r.host}\r\n${hdrs.join('\r\n')}\r\n\r\n`)
      if (head && head.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    for (const s of [socket, up]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => { socket.destroy(); up.destroy() }) }
  })
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${srv.address().port}/`, log,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.closeAllConnections?.(); srv.close(() => r()) }),
  })))
}
