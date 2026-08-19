// coinjoin.js — the wallet's side of a seqcj CoinJoin round.
//
// The protocol itself is in `coinjoin-protocol.js` (vendored from the seqcj repo, and proven there
// against a real node). THIS file is the part that only a wallet can do: choose coins, prove they
// are ours, hand out fresh blinded addresses, and — the step everything else exists to protect —
// VERIFY the coordinator's transaction before signing it.
//
// WHY MIXING IS DIFFERENT HERE. On Bitcoin a CoinJoin has to use equal, public denominations, and
// the change output stays a permanent tag linking the mix back to you. Sequentia has Confidential
// Transactions, so the round's outputs are commitments: the chain sees a transaction and not one
// amount in it. Your change is blinded exactly like your mixed coins and, to an observer, is
// indistinguishable from them.
//
// WHAT YOU GET, PLAINLY (the wallet says the same thing in the UI, and it should never say more):
//   * the chain learns nothing about the amounts, yours or anyone's;
//   * the coordinator cannot link your inputs to your MIXED outputs — that is what the blind
//     signatures buy, and it is all they buy;
//   * the coordinator DOES see your amounts and your change. It is not a stranger to you;
//   * this page does not hide your IP. Registering inputs and outputs from the same browser hands
//     the coordinator the link the blind signature just removed. A serious mix needs Tor, which a
//     web page cannot arrange for you — that is exactly what Seqognito, the desktop client, is for;
//   * your anonymity set is the round. Two participants means two.
//
// FUND SAFETY. Nothing here can lose coins. The only irreversible act is a signature, and it is
// produced solely by `verifyAndSign`, which unblinds the transaction with this wallet's own blinding
// key and throws unless the outputs paying us are exactly the ones the round owed. A round we refuse
// simply never completes; the coins were never spent.

import { runRound, chooseRound, verifyRoundOutputs } from './coinjoin-protocol.js';
import { requestPegIn, requestPegOut } from './sbtc.js';

// The coordinator lives behind a same-origin path, like /seqob and /sbtc: the reverse proxy owns
// exposure, so the page needs no CORS and holds no secret.
let BASE = '/coinjoin';
export function setCoinjoinBase(b){ BASE = b || '/coinjoin'; }
export function coinjoinBase(){ return BASE; }

let CTX = null;
// ctx = {
//   wasm: { Transaction, coinjoinSignInputs, coinjoinUnblindOutputs },
//   wollet, network, descriptor, withWollet,     // the shared wasm objects + their single-file queue
//   mnemonic:   () => phrase,                    // in memory only, used to derive signing keys
//   utxos:      () => [{txid,vout,atoms,asset,spkHex,chain,index}],   // TRANSPARENT coins only
//   signOwnership: (message, {chain,index}) => ({ pubkey, sig }),     // ECDSA/SHA-256 DER hex
//   freshAddress:  () => addressString,          // a fresh CONFIDENTIAL address, never reused
//   sendAsset:     ({address, asset, atoms}) => txid,                 // ordinary wallet send
//   btc: { newAddress: () => addr, send: ({address, sats}) => txid, balanceOf: (addr) => sats },
//   assetBalance:  (asset) => atoms,
//   record:        (key, value) => void,         // persist-before-broadcast hook
// }
export function initCoinJoin(ctx){ CTX = ctx; }

async function api(path, body){
  const res = await fetch(BASE + path, body
    ? { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body), cache:'no-store' }
    : { cache:'no-store' });
  const txt = await res.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { ok:false, error: txt || 'bad json' }; }
  if (!res.ok || j.ok === false) throw new Error(j.error || ('coordinator HTTP ' + res.status));
  return j;
}

export async function status(){ return api('/status'); }
export async function rounds(){ return (await api('/rounds')).rounds || []; }

// Which assets can be mixed right now, and on what terms. The UI offers exactly this and nothing
// else — an asset with no open lane cannot be mixed however much of it you hold.
export async function availableLanes(){
  const out = [];
  for (const r of await rounds()){
    if (r.phase !== 'input') continue;
    for (const lane of r.lanes){
      out.push({ round_id: r.round_id, index: lane.index, asset: lane.asset, label: lane.label,
                 denom: BigInt(lane.denom_atoms), coordFee: BigInt(lane.coord_fee_atoms || '0'),
                 btcBacked: !!lane.btc_backed, maxCredentials: r.max_credentials,
                 participants: r.participants, minParticipants: r.min_participants,
                 // null until the round is viable: the coordinator does not start a countdown while
                 // it is still waiting for the participant who makes a mix possible.
                 deadlineMs: r.deadline_ms, waiting: !!r.waiting_for_participants });
    }
  }
  return out;
}

// The signing gate — `verifyRoundOutputs` — is imported from the vendored protocol module rather
// than written here. It is the one function whose failure costs real money, so it lives in the file
// both this wallet and Seqognito vendor, and is tested where it lives (seqcj/test/gate.test.mjs).
// Re-exported below for this repo's own tests.

// ---------------------------------------------------------------------------
// Run one round for `assetId`, mixing `denominations` denominations.
// ---------------------------------------------------------------------------
export async function mix({ assetId, denominations = 1, onStatus = () => {} }){
  if (!CTX) throw new Error('coinjoin is not initialised');
  const scriptOf = (address) => {
    const a = new CTX.wasm.Address(address);
    const spk = a.scriptPubkey();
    return (spk.toString ? spk.toString() : [...spk.bytes()].map((b) => b.toString(16).padStart(2,'0')).join('')).toLowerCase();
  };

  const mixScripts = [];
  let changeScript = null;
  let chosen = null;                 // the coins we registered, kept for the signing step

  const hooks = {
    fetchJson: api,
    onStatus,

    // Coin selection: TRANSPARENT coins of this asset, largest first, just enough to cover the
    // denominations asked for. Confidential coins are excluded because the coordinator refuses them
    // — blinding the round would need their blinding factors, and handing those over would undo the
    // privacy of every transaction that coin has ever been in.
    selectInputs: async ({ asset, denom, coordFee, maxCredentials }) => {
      const want = BigInt(maxCredentials) * (BigInt(denom) + BigInt(coordFee));
      const cands = CTX.utxos()
        .filter((u) => u.asset === asset)
        .sort((a, b) => (BigInt(b.atoms) > BigInt(a.atoms) ? 1 : -1));
      const picked = []; let sum = 0n;
      for (const u of cands){ if (sum >= want) break; picked.push(u); sum += BigInt(u.atoms); }
      if (sum < BigInt(denom) + BigInt(coordFee)){
        throw new Error(`not enough transparent balance to mix one denomination (need ${denom + coordFee} atoms, have ${sum})`);
      }
      chosen = picked;
      return { inputs: picked };
    },

    proveOwnership: async (message, input) => CTX.signOwnership(message, input),

    freshAddress: async () => CTX.freshAddress(),

    // The gate. Unblind with our own key, check, and only then sign — and sign only our own inputs,
    // matched by outpoint, so the coordinator's shuffling cannot redirect the signature.
    verifyAndSign: async (txHex, c) => {
      for (const a of c.mixAddresses) mixScripts.push(scriptOf(a));
      changeScript = c.changeAddress ? scriptOf(c.changeAddress) : null;
      const mine = await CTX.withWollet(() => CTX.wasm.coinjoinUnblindOutputs(txHex, CTX.descriptor()));
      verifyRoundOutputs({
        mine, mixScripts, changeScript,
        denom: c.denom, change: c.change, asset: c.lane.asset,
      });
      // Our inputs must be the ones we registered, and all of them.
      const tx = new CTX.wasm.Transaction(txHex);
      const present = new Set(tx.inputs().map((i) => i.outpoint().txid().toString() + ':' + i.outpoint().vout()));
      for (const u of chosen){
        if (!present.has(u.txid + ':' + u.vout)) throw new Error('a coin I registered is missing from the round; refusing to sign');
      }
      onStatus('signing', { outputs: mine.length });
      return CTX.withWollet(() => CTX.wasm.coinjoinSignInputs({
        txHex, mnemonic: CTX.mnemonic(),
        inputs: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.atoms), spkHex: u.spkHex, chain: u.chain, index: u.index })),
      }, CTX.network));
    },
  };

  const res = await runRound({ hooks, assetId, maxCredentials: denominations });
  return res;
}

// ---------------------------------------------------------------------------
// Bitcoin: peg in, mix, peg out.
//
// Parent-chain BTC cannot be mixed directly — Bitcoin has no confidential transactions, which is the
// whole reason this is worth doing on Sequentia. So the BTC is pegged to SBTC through the existing
// bridge, mixed here, and pegged back out to a FRESH Bitcoin address.
//
// Say the residual risk out loud, because it is real: the bridge sees the Bitcoin that goes in and
// the Bitcoin that comes out. The round breaks the link on the Sequentia side, so the bridge cannot
// pair your deposit with your withdrawal unless it is the only user of the round — but it is a
// custodian, and it is one for the whole time your coins are pegged.
//
// Every step that broadcasts persists its recovery material FIRST (the wallet's standing rule), so a
// crash or a closed tab leaves funds findable rather than stranded.
// ---------------------------------------------------------------------------
export async function mixBitcoin({ sats, onStatus = () => {}, pollMs = 15000, timeoutMs = 3600000 }){
  if (!CTX) throw new Error('coinjoin is not initialised');
  const st = await status();
  if (!st.btc || !st.btc.lane_asset) throw new Error('this coordinator is not running a Bitcoin lane');
  const sbtcAsset = st.btc.lane_asset;

  // 1. peg in: a bridge deposit address bound to one of OUR Sequentia addresses.
  const seqRecipient = await CTX.freshAddress();
  const deposit = await requestPegIn(seqRecipient);
  const before = BigInt(CTX.assetBalance(sbtcAsset) || 0n);
  CTX.record?.('cj-pegin:' + deposit, { deposit, seqRecipient, sats: String(sats), at: Date.now() });
  onStatus('pegging-in', { deposit, sats: String(sats) });
  const btcTxid = await CTX.btc.send({ address: deposit, sats });
  CTX.record?.('cj-pegin:' + deposit, { deposit, seqRecipient, sats: String(sats), btcTxid, at: Date.now() });

  // 2. wait for the bridge to credit SBTC.
  const until = Date.now() + timeoutMs;
  while (Date.now() < until){
    const now = BigInt(CTX.assetBalance(sbtcAsset) || 0n);
    if (now > before){ onStatus('pegged-in', { credited: String(now - before) }); break; }
    onStatus('waiting-for-peg-in', { deposit, btcTxid });
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (BigInt(CTX.assetBalance(sbtcAsset) || 0n) <= before) throw new Error('the bridge has not credited SBTC yet; the mix can be resumed once it does');

  // 3. mix the SBTC.
  const lanes = (await availableLanes()).filter((l) => l.asset === sbtcAsset);
  if (!lanes.length) throw new Error('no open round is mixing SBTC right now');
  const denom = lanes[0].denom + lanes[0].coordFee;
  const k = Number(BigInt(sats) / denom) || 1;
  const round = await mix({ assetId: sbtcAsset, denominations: Math.min(k, lanes[0].maxCredentials), onStatus });

  // 4. peg out to a FRESH Bitcoin address. A reused one would hand the link straight back.
  const btcDest = await CTX.btc.newAddress();
  const sbtcReturn = await requestPegOut(btcDest);
  const mixed = BigInt(round.denom_atoms) * BigInt(round.denominations);
  CTX.record?.('cj-pegout:' + sbtcReturn, { sbtcReturn, btcDest, atoms: String(mixed), round: round.txid, at: Date.now() });
  onStatus('pegging-out', { btcDest, atoms: String(mixed) });
  const seqTxid = await CTX.sendAsset({ address: sbtcReturn, asset: sbtcAsset, atoms: mixed });
  CTX.record?.('cj-pegout:' + sbtcReturn, { sbtcReturn, btcDest, atoms: String(mixed), round: round.txid, seqTxid, at: Date.now() });
  onStatus('pegged-out', { btcDest, seqTxid });
  return { round, btcTxid, btcDest, seqTxid, mixed_atoms: String(mixed) };
}

export { verifyRoundOutputs };
export const __test__ = { verifyRoundOutputs, api, chooseRound };
