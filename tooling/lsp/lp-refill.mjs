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
// says what it would do; --apply sends. One refill per asset is in flight at a time, followed by
// its txid in the state file, and the next one waits until that refill has landed for good: the
// LP node learns of a coin paid to it only once it is in a block (never from the mempool), and the
// stats count confirmed coins only, so a page that still says "low" proves nothing. It never sends
// for an asset when:
//   - its last refill is in the mempool, was put back there by a rollback, is conflicted, is
//     unknown to the inventory wallet, or is confirmed but not yet a confirmed coin of the LP node,
//     or became one less than two minutes ago (the stats are cached a minute);
//   - a send was started and its txid never recorded (the process died mid-send): the wallet's
//     history is searched for it by address, and the asset waits until it is found or ruled out;
//   - the LP node has an unconfirmed coin of that asset (something else of its own still landing);
//   - its last refill is more recent than the cooldown;
//   - the LP node is not on the Sequentia node's chain (after a rollback it can sit on a dropped
//     branch for an hour, blind to coins that did arrive);
//   - the inventory would be left under its floor.
// A refill that stays in the mempool, or is conflicted or lost, holds its asset until a person
// looks: the log says so on every pass, and nothing is sent again by itself.
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

const SETTLE_MS = 2 * 60000;     // after the LP node holds a refill, for the cached stats to count it
const STUCK_MS = 2 * 3600000;    // a refill this long without confirming is called stuck

// Whether the last refill of an asset holds the next one back, and why. Pure.
//   rec: { txid, address, at, seen_at } from the state file (txid null: the send was started and
//        its txid never recorded, and the wallet's history did not show it either)
//   confirmations: the inventory wallet's gettransaction answer for rec.txid (null: unknown)
//   lpHolds: the LP node holds rec.txid as a confirmed coin
// Returns { hold: reason | null, seen_at } — seen_at is what the record's seen_at becomes.
export function refillHold(rec, { confirmations, lpHolds, now }) {
  if (!rec) return { hold: null, seen_at: null };
  const mins = (t) => Math.round((now - t) / 60000);
  const keep = rec.seen_at || null;
  if (!rec.txid) return { hold: `a send to ${rec.address} started ${mins(rec.at)} min ago has no recorded txid and is not in the wallet's history: check by hand, then remove it from the state file`, seen_at: keep };
  if (confirmations == null) return { hold: `the last refill ${rec.txid} is unknown to the inventory wallet: check by hand`, seen_at: keep };
  if (confirmations < 0) return { hold: `the last refill ${rec.txid} is conflicted (a rival spend is ${-confirmations} blocks deep): check by hand`, seen_at: keep };
  if (confirmations === 0) {
    const stuck = now - rec.at > STUCK_MS ? ', stuck: check by hand' : '';
    return { hold: `the last refill ${rec.txid} is in the mempool (sent ${mins(rec.at)} min ago${rec.seen_at ? ', back there after a rollback' : ''})${stuck}`, seen_at: null };
  }
  if (!lpHolds) return { hold: `the last refill ${rec.txid} is confirmed but the LP node does not hold it yet`, seen_at: null };
  const seen = rec.seen_at || now;
  if (now - seen < SETTLE_MS) return { hold: `the last refill ${rec.txid} just reached the LP node; waiting for the stats to count it`, seen_at: seen };
  return { hold: null, seen_at: seen };
}

// What to send. Pure: `stats` is GET /stats/inbound, `inventory` atoms per asset in the inventory
// wallet, `pending` the assets with an unconfirmed coin on the LP node, `holds` the reason the
// last refill holds each asset back (refillHold), `last` the time of the last refill per asset.
// Returns { sends: [{ asset, ticker, atoms, value_ref }], skips: [{ asset, ticker, reason }] }; an
// asset that is fine appears in neither.
export function planRefills({ stats, inventory, pending, holds = {}, last, now, cfg }) {
  const sends = [], skips = [];
  const lowRef = cfg.lowRef ?? (stats.terms && stats.terms.low_ref) ?? 1000;
  for (const a of stats.assets || []) {
    const asset = String(a.asset).toLowerCase(), ticker = a.ticker;
    const price = Number(a.price_ref);
    if (!(price > 0)) continue;                                   // unpriced: nothing to size by
    if (!(Number(a.sellable_ref) < lowRef)) continue;              // not low
    const skip = (reason) => skips.push({ asset, ticker, reason });
    if (holds[asset]) { skip(holds[asset]); continue; }
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
  if (j.error) {
    // The node answered and refused: nothing was done. Any other failure (a timeout, a dropped
    // connection) leaves it unknown whether the call went through.
    const e = new Error(`${method}: ${j.error.message || 'error'}`);
    e.refused = true;
    throw e;
  }
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
  let s;
  try { s = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { refills: {} };
    throw new Error(`the state file ${file} is unreadable (${e.message}): fix it before refilling`);
  }
  return { refills: {}, ...s };
}

async function writeState(file, state) {
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${file}.tmp`, file);
}

// A send whose txid was never recorded: the wallet's own record of it, by the address it paid.
async function findSend(cfg, address) {
  const txs = await seqRpc(cfg, 'listtransactions', ['*', 1000, 0, true], cfg.wallet);
  const hit = (txs || []).find((t) => t.category === 'send' && t.address === address);
  return hit ? hit.txid : null;
}

// How each asset's last refill stands, from the inventory wallet and the LP node. Fills in a
// recovered txid and the seen_at times in `state`; returns the holds and whether state changed.
async function followRefills(cfg, state, funds, now) {
  const holds = {};
  let changed = false;
  for (const [asset, rec] of Object.entries(state.refills)) {
    if (!rec.txid && rec.address) {
      const txid = await findSend(cfg, rec.address);
      if (txid) { rec.txid = txid; changed = true; }
    }
    let confirmations = null;
    if (rec.txid) {
      try { confirmations = Number((await seqRpc(cfg, 'gettransaction', [rec.txid], cfg.wallet)).confirmations); }
      catch (e) { if (!e.refused) throw e; }       // refused: the wallet does not know it
    }
    const lpHolds = !!rec.txid && ((funds && funds.outputs) || []).some((o) => o.txid === rec.txid && o.status === 'confirmed');
    const { hold, seen_at } = refillHold(rec, { confirmations, lpHolds, now });
    if ((rec.seen_at || null) !== seen_at) { rec.seen_at = seen_at; changed = true; }
    if (hold) holds[asset] = hold;
  }
  return { holds, changed };
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
  const { holds, changed } = await followRefills(cfg, state, funds, now);
  if (changed && apply) await writeState(cfg.stateFile, state);
  const last = Object.fromEntries(Object.entries(state.refills).map(([a, rec]) => [a, rec.at]));
  const { sends, skips } = planRefills({ stats, inventory: inventoryAtoms(utxos), pending: pendingAssets(funds),
    holds, last, now, cfg });

  for (const s of skips) console.log(`lp-refill: ${s.ticker} low, skipped: ${s.reason}`);
  if (!sends.length) { if (!skips.length) console.log('lp-refill: every asset above the low line'); return 0; }

  let failed = 0;
  for (const s of sends) {
    const line = `${s.ticker} ${unitsString(s.atoms)} (~${fmt(s.value_ref)})`;
    if (!apply) { console.log(`lp-refill: would send ${line}`); continue; }
    let address = null;
    try {
      const na = await ln(cfg, 'newaddr', ['addresstype=bech32']);
      address = na.bech32 || na.address;
      if (!address) throw new Error('newaddr gave no address');
      // Recorded before the send: if this process dies before it learns the txid, the next pass
      // finds the send by its address and never sends a second time meanwhile.
      state.refills[s.asset] = { txid: null, address, at: now, seen_at: null };
      await writeState(cfg.stateFile, state);
      // Named params: amount in whole units, the asset and the fee asset by id.
      const txid = await seqRpc(cfg, 'sendtoaddress', { address, amount: unitsString(s.atoms), assetlabel: s.asset,
        fee_asset_label: s.asset }, cfg.wallet);
      state.refills[s.asset].txid = txid;
      await writeState(cfg.stateFile, state);
      console.log(`lp-refill: sent ${line} from ${cfg.wallet} to the LP node, txid ${txid}`);
    } catch (e) {
      failed += 1;
      // A send the node refused never happened: drop its record so the asset is not held for it.
      if (e.refused && state.refills[s.asset] && state.refills[s.asset].address === address && !state.refills[s.asset].txid) {
        delete state.refills[s.asset];
        await writeState(cfg.stateFile, state);
      }
      console.error(`lp-refill: ${s.ticker} refill failed: ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`lp-refill: ${e.message}`); process.exit(1); });
}
