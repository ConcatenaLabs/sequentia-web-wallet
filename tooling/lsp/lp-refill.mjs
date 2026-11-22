// Top the LP node back up when the room-to-receive service runs low on an asset.
//
// The service sells room from the confirmed, unreserved coins of its LP node (SUBAS_LP_RPC); every
// sale locks some of them in a channel, and nothing gives them back until the channel closes. This
// script reads the same public numbers as sequentiatestnet.com/liquidity (GET /stats/inbound) and,
// for each asset whose sellable stock is under the "low" line, sends coins from the operator's
// inventory wallet (FRONT_SEQ_WALLET) to a fresh address of the LP node, so that its free stock is
// back at the target. The fee of each send is paid in the asset sent.
//
// It is run once per invocation (a systemd timer runs it every few minutes) and, by default, only
// says what it would do; --apply sends. It never sends for an asset when:
//   - the LP node has an unconfirmed coin of that asset (a refill, or anything else, still landing:
//     the stats count confirmed coins only, so sending again would double it);
//   - the last refill of that asset is more recent than the cooldown (state file);
//   - the LP node is not on the Sequentia node's chain (after a rollback it can sit on a dropped
//     branch for an hour, blind to coins that did arrive);
//   - the inventory would be left under its floor.
//
//   node tooling/lsp/lp-refill.mjs            # plan only
//   node tooling/lsp/lp-refill.mjs --apply    # send
//
// Configuration (environment; the LSP's own env file supplies the first four):
//   SEQ_RPC            http://user:pass@host:port of the Sequentia node
//   FRONT_SEQ_WALLET   the inventory wallet the coins come from
//   SUBAS_LP_RPC       the LP node's lightning-rpc
//   LNCLI              lightning-cli
//   LP_REFILL_STATS_URL   default http://127.0.0.1:${LSP_PORT || 9981}/stats/inbound
//   LP_REFILL_LOW_REF     refill under this sellable value (default: the service's own low line)
//   LP_REFILL_TARGET_REF  free value to bring the asset back to (default 20000)
//   LP_REFILL_MAX_REF     most one refill sends (default 25000)
//   LP_REFILL_KEEP_REF    least the inventory keeps of each asset (default 5000)
//   LP_REFILL_COOLDOWN_MIN  minutes between two refills of one asset (default 30)
//   LP_REFILL_STATE       state file (default /root/sequentia/lsp/prov/lp-refill.json)

import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SCALE = 1e8;

// Atoms as a whole-unit amount string for sendtoaddress (8 decimals, no float rounding).
export function unitsString(atoms) {
  const a = Math.floor(Number(atoms));
  if (!(a > 0)) throw new Error(`not a positive amount: ${atoms}`);
  return `${Math.floor(a / SCALE)}.${String(a % SCALE).padStart(8, '0')}`;
}

// Assets with an unconfirmed coin on the LP node.
export function pendingAssets(listfunds) {
  const s = new Set();
  for (const o of (listfunds && listfunds.outputs) || []) {
    if (o.status === 'confirmed' || o.reserved) continue;
    if (o.asset) s.add(String(o.asset).toLowerCase());
  }
  return s;
}

// Confirmed atoms per asset in the inventory wallet (listunspent leaves locked coins out).
export function inventoryAtoms(utxos) {
  const by = {};
  for (const u of utxos || []) {
    const a = String(u.asset || '').toLowerCase(); if (!a) continue;
    by[a] = (by[a] || 0) + Math.round(Number(u.amount || 0) * SCALE);
  }
  return by;
}

// What to send. Pure: `stats` is GET /stats/inbound, `inventory` atoms per asset in the inventory
// wallet, `pending` the assets with an unconfirmed coin on the LP node, `last` the time of the
// last refill per asset. Returns { sends: [{ asset, ticker, atoms, value_ref }], skips: [{ asset,
// ticker, reason }] }; an asset that is fine appears in neither.
export function planRefills({ stats, inventory, pending, last, now, cfg }) {
  const sends = [], skips = [];
  const lowRef = cfg.lowRef ?? (stats.terms && stats.terms.low_ref) ?? 1000;
  for (const a of stats.assets || []) {
    const asset = String(a.asset).toLowerCase(), ticker = a.ticker;
    const price = Number(a.price_ref);
    if (!(price > 0)) continue;                                   // unpriced: nothing to size by
    if (!(Number(a.sellable_ref) < lowRef)) continue;              // not low
    const skip = (reason) => skips.push({ asset, ticker, reason });
    if (pending.has(asset)) { skip('a coin of this asset is still unconfirmed on the LP node'); continue; }
    const since = now - (last[asset] || 0);
    if (since < cfg.cooldownMs) { skip(`refilled ${Math.round(since / 60000)} min ago`); continue; }
    const wantRef = Math.min(cfg.targetRef - Number(a.free_ref || 0), cfg.maxRef);
    if (!(wantRef > 0)) { skip('free stock already at the target'); continue; }
    const perAtom = price / SCALE;
    const have = inventory[asset] || 0;
    // Units first, then atoms; the epsilon keeps 4.95 from flooring to 4.94999999.
    const toAtoms = (ref) => (ref / price) * SCALE;
    const keep = Math.ceil(toAtoms(cfg.keepRef) - 1e-6);
    const atoms = Math.min(Math.floor(toAtoms(wantRef) + 1e-6), have - keep);
    if (!(atoms > 0)) { skip(`the inventory holds ${have} atoms, under its floor of ${keep}`); continue; }
    sends.push({ asset, ticker, atoms, value_ref: atoms * perAtom });
  }
  return { sends, skips };
}

// ---------------------------------------------------------------------------------------------
// I/O

function config(env) {
  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  return {
    seqRpc: env.SEQ_RPC, wallet: env.FRONT_SEQ_WALLET, lpRpc: env.SUBAS_LP_RPC, lncli: env.LNCLI || 'lightning-cli',
    statsUrl: env.LP_REFILL_STATS_URL || `http://127.0.0.1:${env.LSP_PORT || 9981}/stats/inbound`,
    lowRef: env.LP_REFILL_LOW_REF ? Number(env.LP_REFILL_LOW_REF) : null,
    targetRef: num('LP_REFILL_TARGET_REF', 20000), maxRef: num('LP_REFILL_MAX_REF', 25000),
    keepRef: num('LP_REFILL_KEEP_REF', 5000), cooldownMs: num('LP_REFILL_COOLDOWN_MIN', 30) * 60000,
    stateFile: env.LP_REFILL_STATE || '/root/sequentia/lsp/prov/lp-refill.json',
  };
}

async function seqRpc(cfg, method, params, wallet = '') {
  const u = new URL(cfg.seqRpc);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  const r = await fetch(`${u.protocol}//${u.host}${wallet ? `/wallet/${encodeURIComponent(wallet)}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'lp-refill', method, params }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || 'error'}`);
  return j.result;
}

function ln(cfg, method, kv = []) {
  return new Promise((resolve, reject) => {
    execFile(cfg.lncli, [`--rpc-file=${cfg.lpRpc}`, '-N', 'none', '-k', method, ...kv], { maxBuffer: 32 << 20, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${method}: ${(stderr || err.message).trim()}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad json`)); }
      });
  });
}

// The LP node follows the Sequentia node's chain: same block at its height, and not far behind.
async function lpInSync(cfg) {
  const info = await ln(cfg, 'getinfo');
  const tip = await seqRpc(cfg, 'getblockcount', []);
  const h = Number(info.blockheight);
  if (h > tip) return `the LP node is at ${h}, above the node's tip ${tip} (a dropped branch)`;
  if (tip - h > 3) return `the LP node is at ${h}, ${tip - h} blocks behind the node`;
  return null;
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { last: {} }; }
}

async function writeState(file, state) {
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${file}.tmp`, file);
}

const fmt = (x) => (x == null ? '?' : Math.round(x).toLocaleString('en-US'));

export async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  const cfg = config(env);
  for (const k of ['seqRpc', 'wallet', 'lpRpc']) if (!cfg[k]) throw new Error(`missing configuration: ${k}`);

  const stale = await lpInSync(cfg);
  if (stale) { console.log(`lp-refill: not refilling, ${stale}`); return 0; }

  const r = await fetch(cfg.statsUrl, { signal: AbortSignal.timeout(30000) });
  const stats = await r.json();
  if (!stats.ok) throw new Error('stats unavailable');
  const [funds, utxos, state] = await Promise.all([
    ln(cfg, 'listfunds'), seqRpc(cfg, 'listunspent', [1, 9999999], cfg.wallet), readState(cfg.stateFile),
  ]);
  const now = Date.now();
  const { sends, skips } = planRefills({ stats, inventory: inventoryAtoms(utxos), pending: pendingAssets(funds),
    last: state.last || {}, now, cfg });

  for (const s of skips) console.log(`lp-refill: ${s.ticker} low, skipped: ${s.reason}`);
  if (!sends.length) { if (!skips.length) console.log('lp-refill: every asset above the low line'); return 0; }

  let failed = 0;
  for (const s of sends) {
    const line = `${s.ticker} ${unitsString(s.atoms)} (~${fmt(s.value_ref)})`;
    if (!apply) { console.log(`lp-refill: would send ${line}`); continue; }
    try {
      const na = await ln(cfg, 'newaddr', ['addresstype=bech32']);
      const address = na.bech32 || na.address;
      if (!address) throw new Error('newaddr gave no address');
      // Named params: amount in whole units, the asset and the fee asset by id.
      const txid = await seqRpc(cfg, 'sendtoaddress', { address, amount: unitsString(s.atoms), assetlabel: s.asset,
        fee_asset_label: s.asset }, cfg.wallet);
      state.last = { ...(state.last || {}), [s.asset]: now };
      await writeState(cfg.stateFile, state);
      console.log(`lp-refill: sent ${line} from ${cfg.wallet} to the LP node, txid ${txid}`);
    } catch (e) {
      failed += 1;
      console.error(`lp-refill: ${s.ticker} refill failed: ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`lp-refill: ${e.message}`); process.exit(1); });
}
