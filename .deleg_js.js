
// ---------- staking pools ----------
// Delegating lends this wallet's stake WEIGHT to a pool's signer; the staked
// coins are never touched and the pool can never spend them, because the pool's
// key appears nowhere in the staking output's spending condition. The lend is
// one small bare output, the delegation record, which only this wallet's staking
// key can spend. That is why leaving needs nobody's cooperation, and why the
// wallet has to be able to spend a bare script at all (SWK buildDelegationSpendTx):
// offering "join a pool" without "leave a pool" would be a one-way door.
//
// Starting a pool is deliberately NOT here. Announcing a payout policy binds
// every block a key ever produces and needs that key online on the machine
// producing them, so it lives only in the node wallet.
const POOLS_FEED = '/pools/pools.json';
// Cache of the last pool board reading, so the pool a delegation points at can
// still be described when the feed is briefly away.
let POOLS = null;
// The live delegation record, discovered from the chain: {txid, vout, atoms, signer, confirmed}.
let DELEG = null;
let DELEG_SEL = null;   // the pool row the user has picked

async function fetchPools(){
  try{
    const r = await fetch(POOLS_FEED, {cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    if(j && Array.isArray(j.pools)) POOLS = j;
  }catch(e){ /* keep the previous reading; the UI says when it has none */ }
  return POOLS;
}

// Find this wallet's delegation record without any local bookkeeping.
//
// The record is a bare script, so the wallet does not track it as its own coin
// and a restored seed has no note of it. But the transaction that FUNDED it
// spent this wallet's coins, so it is in the wallet's history: scan those
// outputs for a script that parses as a record naming our staking key, then ask
// the explorer whether it is still unspent. No index, no pool list, no state.
async function discoverDelegation(){
  let mine;
  try{ mine = signer.stakerPublicKey(); }catch{ return null; }
  const candidates = [];
  try{
    for(const wtx of wollet.transactions()){
      let hex; try{ hex = wtx.tx().toString(); }catch{ continue; }
      let found; try{ found = findDelegationRecords(hex, mine); }catch{ continue; }
      for(const f of found||[]){
        candidates.push({txid: wtx.txid().toString(), vout: f.vout, signer: f.signer,
                         atoms: BigInt(f.value), height: wtx.height()});
      }
    }
  }catch(e){ return null; }
  if(!candidates.length) return null;
  // Newest first: a move spends the old record and creates a new one, so the
  // most recent unspent record is the one in force. An unconfirmed one sorts
  // first, because it is the most recent thing that happened.
  candidates.sort((a,b)=>(b.height??Infinity)-(a.height??Infinity));
  for(const c of candidates){
    try{
      // Authoritative, and the one thing the wallet cannot answer itself: the
      // record is a bare script, so a transaction spending it need not touch
      // this wallet at all and may never be downloaded.
      const r = await fetch(`${ESPLORA}/tx/${c.txid}/outspend/${c.vout}`);
      if(!r.ok) continue;
      const j = await r.json();
      if(j && j.spent) continue;                       // superseded or already reclaimed
      const st = await fetch(`${ESPLORA}/tx/${c.txid}/status`);
      c.confirmed = st.ok ? !!(await st.json()).confirmed : false;
      return c;
    }catch{ /* transient: try the next candidate */ }
  }
  return null;
}

function poolPayoutLine(p){
  if(!p) return 'unknown';
  return p.payout || 'unknown';
}

function renderPools(){
  const list = $('poolList'); if(!list) return;
  list.innerHTML='';
  if(!POOLS || !POOLS.pools.length){
    list.appendChild(el('div','muted', POOLS ? 'No pools are producing yet.' : 'Pool list unavailable right now.'));
    return;
  }
  const total = Number(POOLS.network_weight)||0;
  for(const p of POOLS.pools){
    const item = el('div','item');
    item.style.cursor='pointer';
    if(DELEG_SEL===p.signer || (DELEG && DELEG.signer===p.signer)) item.style.outline='1px solid var(--gold, #f5b301)';
    const mid = el('div','grow');
    mid.appendChild(el('div', 'mono', p.signer.slice(0,16)+'…'));
    const share = total ? (Number(p.weight)/total*100).toFixed(1)+'%' : '—';
    const rel = (p.reliability===undefined) ? 'no blocks owed yet'
              : ('produces '+p.reliability.toFixed(2)+' of its share');
    mid.appendChild(el('div','sub', `${fmtAtoms(BigInt(p.weight),8)} tSEQ (${share} of the network) · ${p.delegators} delegator(s) · ${rel}`));
    mid.appendChild(el('div','sub', poolPayoutLine(p)));
    if((p.policy_pending||[]).length){
      const w = el('div','sub','⚠ has announced a payout change that binds in '+p.policy_pending[0].blocks_away+' blocks');
      w.style.color='#f5b301';
      mid.appendChild(w);
    }
    if(p.eligible===false){
      const w = el('div','sub','below the network minimum stake, so it cannot produce yet');
      w.style.color='#e88';
      mid.appendChild(w);
    }
    item.appendChild(mid);
    item.onclick=()=>{ DELEG_SEL=p.signer; $('delegSigner').value=p.signer; renderPools(); };
    list.appendChild(item);
  }
}

function renderDelegation(){
  const st=$('delegStatus'); if(!st) return;
  const alerts=$('delegAlerts'); alerts.innerHTML='';
  const row=$('delegPoolRow'), leave=$('btnUndelegate'), go=$('btnDelegate');
  if(!DELEG){
    st.textContent='Not delegating. Your stake signs for itself, so this wallet has to be producing blocks to earn from it.';
    row.style.display='none';
    leave.style.display='none';
    go.textContent='Delegate';
    return;
  }
  const pool = POOLS && POOLS.pools.find(p=>p.signer===DELEG.signer);
  st.textContent = DELEG.confirmed
    ? 'Delegated. Your stake weight is producing blocks for the pool below; your coins have not moved.'
    : 'Delegation sent, waiting to confirm. Until it does, your weight still counts for you.';
  row.style.display='';
  $('delegPool').textContent = DELEG.signer.slice(0,16)+'…';
  leave.style.display='';
  go.textContent='Move to the selected pool';

  const warn = (text)=>{ const d=el('div','sub','⚠ '+text); d.style.cssText='color:#f5b301;margin:6px 0'; alerts.appendChild(d); };
  if(!pool){
    warn('This pool is not on the board right now, so what it has committed to cannot be shown. Leaving always works.');
    return;
  }
  if(!pool.policy_in_force){
    warn('This pool has committed to no payout policy, so by default it keeps everything its blocks earn. Nothing on-chain obliges it to pay you.');
  } else if(pool.policy_in_force.mode==='direct'){
    warn('This pool pays a committed address. The chain stops it redirecting the reward silently, but does not check that address shares anything with you.');
  }
  for(const q of (pool.policy_pending||[])){
    const secs = q.blocks_away * (POOLS.block_seconds||60);
    const when = new Date(Date.now()+secs*1000);
    warn(`This pool has announced a NEW payout policy (${q.mode}${q.commission_bp!==undefined?', '+(q.commission_bp/100).toFixed(2)+'% commission':''}) `
       + `binding in ${q.blocks_away} blocks, around ${when.toLocaleString()}. If you do not accept it, leave before then: leaving is immediate and needs nobody's permission.`);
  }
  if(pool.reliability!==undefined && pool.reliability < 0.5){
    warn('This pool has produced far fewer blocks than its weight is owed. While that lasts, your delegated weight is earning you nothing.');
  }
}

async function refreshDelegation(){
  await fetchPools();
  try{ DELEG = await discoverDelegation(); }catch{ DELEG = null; }
  renderPools();
  renderDelegation();
}

// The record's own value. It has to clear the dust floor and then pay the fee
// each time it is re-pointed, so it is sized for a handful of moves rather than
// exactly one. It all comes back when the delegation is reclaimed.
const DELEG_RECORD_ATOMS = 100000n;   // 0.001 tSEQ

// The seed, from where every other signing flow in this wallet reads it. A
// watch-only wallet has none, and cannot spend a record: say so rather than
// failing inside the builder.
function delegMnemonic(){
  const m=(localStorage.getItem(KEY)||'').trim();
  if(!m) throw new Error('this wallet has no seed loaded, so it cannot sign the delegation record');
  return m;
}

$('btnDelegate').onclick=async()=>{
  $('delegErr').textContent='';
  try{
    const target=($('delegSigner').value||'').trim().toLowerCase();
    if(!/^0[23][0-9a-f]{64}$/.test(target)) throw new Error('pick a pool above, or paste its 66-character signer key');
    const controller=signer.stakerPublicKey();
    if(target===controller) throw new Error('that is your own staking key; delegating to yourself is what already happens with no pool at all');

    if(DELEG){
      // Moving pools: spend the old record and create the new one in ONE
      // transaction. Consensus allows only one live record per staking key, so
      // two separate transactions could be mined in the order that invalidates
      // a block.
      if(DELEG.signer===target) throw new Error('you are already delegating to that pool');
      if(!DELEG.confirmed) throw new Error('your last delegation change has not confirmed yet; wait for it');
      const fee = 500n;   // ~200 vB at the wallet's default rate, out of the record
      const built = buildDelegationSpendTx({
        mnemonic: delegMnemonic(),
        recordTxid: DELEG.txid, recordVout: DELEG.vout,
        recordValue: DELEG.atoms.toString(),
        currentSigner: DELEG.signer,
        rotateTo: target,
        feeAtoms: fee.toString(),
        locktime: await tipHeight(),
      }, network);
      const txid = await broadcastSeqRaw(built.rawHex);
      toast('Moving to the new pool:', {href:'/explorer/tx/'+txid, label:txid.slice(0,18)+'…'});
      await refreshDelegation();
      return;
    }

    const pset = network.txBuilder()
      .addDelegationOutput(controller, target, DELEG_RECORD_ATOMS)
      .feeRate(DEFAULT_FEERATE)
      .finish(wollet);
    await reviewBroadcast(pset, 'Delegate to a staking pool', async ()=>{
      $('delegSigner').value=''; DELEG_SEL=null;
      await refreshDelegation();
    }, POLICY_HEX, {rows:[{atoms:DELEG_RECORD_ATOMS, hex:POLICY_HEX}], feeAssetHex:POLICY_HEX});
  }catch(e){ $('delegErr').textContent = e?.message ?? String(e); }
};

$('btnUndelegate').onclick=async()=>{
  $('delegErr').textContent='';
  try{
    if(!DELEG) throw new Error('you are not delegating');
    if(!DELEG.confirmed) throw new Error('your last delegation change has not confirmed yet; wait for it');
    // Explicit, not confidential: the record spend creates an unblinded output.
    const addr = wollet.address(undefined).address().toUnconfidential().toString();
    const fee = 500n;
    const built = buildDelegationSpendTx({
      mnemonic: delegMnemonic(),
      recordTxid: DELEG.txid, recordVout: DELEG.vout,
      recordValue: DELEG.atoms.toString(),
      currentSigner: DELEG.signer,
      reclaimAddress: addr,
      feeAtoms: fee.toString(),
      locktime: await tipHeight(),
    }, network);
    const txid = await broadcastSeqRaw(built.rawHex);
    toast('Leaving the pool:', {href:'/explorer/tx/'+txid, label:txid.slice(0,18)+'…'});
    await refreshDelegation();
  }catch(e){ $('delegErr').textContent = e?.message ?? String(e); }
};

// nLockTime for the record spends: the current tip, so the transaction cannot be
// mined into a block before it was made (anti fee-sniping), and never a height
// in the future, which would make it unminable.
async function tipHeight(){
  try{
    const r = await fetch(`${ESPLORA}/blocks/tip/height`);
    if(r.ok){ const h = parseInt((await r.text()).trim(), 10); if(Number.isFinite(h) && h>=0) return h; }
  }catch{}
  return 0;
}
