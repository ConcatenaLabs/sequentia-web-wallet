// The mixed same-chain SELL derivation must never invert (pay x 1/price): seen live on a
// GOLD->EURX sell where a wrong-direction row reached the compose pricing pool during a
// partial book load and the receive field painted a dust amount (0.001 GOLD -> 0.00000026
// EURX instead of 3.8 EURX), silently disabling Place. Pins:
//   1. bestReceivePerPay prices ONLY rows paying out the RECEIVE asset (orientation guard);
//      a pool holding ONLY a wrong-direction row yields NO price (null), never an inverted one.
//   2. the full requoteMixed sell path (dir-5 sub-asset offer, quote asset in BTC's place)
//      derives receive = pay x price (3.8 EURX for 0.001 GOLD at 3800), Review enabled.
import assert from 'node:assert';

const _ls = new Map();
globalThis.localStorage = { getItem:(k)=>(_ls.has(k)?_ls.get(k):null), setItem:(k,v)=>_ls.set(k,String(v)), removeItem:(k)=>_ls.delete(k) };
function mkEl(tag='div'){ const s=new Set(); return { tag, innerHTML:'', textContent:'', title:'', disabled:false, id:'', value:'', style:{},
  children:[], onclick:null, dataset:{}, _userTyped:false, _refMode:false,
  classList:{ add:(c)=>s.add(c), remove:(c)=>s.delete(c), toggle:(c,on)=>{on?s.add(c):s.delete(c);}, contains:(c)=>s.has(c) },
  appendChild(c){ this.children.push(c); return c; }, querySelectorAll(){ return []; },
  addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){}, scrollIntoView(){} }; }
const REG = {};
const GOLD = '3a'.repeat(32), EURX = 'e3'.repeat(32);
function fmtAtoms(atoms, prec){ atoms=BigInt(atoms); const s=atoms.toString().padStart((prec||0)+1,'0');
  const i=s.slice(0,s.length-(prec||0))||'0'; let f=prec?s.slice(s.length-prec).replace(/0+$/,''):''; return i+(f?'.'+f:''); }
function parseAtoms(str,prec){ const n=parseFloat(String(str==null?'':str).replace(/,/g,'')); if(!Number.isFinite(n)) throw new Error('bad amount'); return BigInt(Math.round(n*Math.pow(10,prec||0))); }
const C = {
  $: (id)=>REG[id]||(REG[id]=mkEl('div')),
  el: (t,c,x)=>{const e=mkEl(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e;},
  assetMeta: (h)=> h==='BTC'?{ticker:'BTC',precision:8}: h===GOLD?{ticker:'GOLD',precision:8}:{ticker:'EURX',precision:8},
  fmtAtoms, parseAtoms, assetAmountOf: (el)=>(el&&el.value)||'', refValueStr: ()=>'',
  wollet:{ tip:()=>({height:()=>300}) }, toast:()=>{}, prettyErr:(e)=>(e&&e.message)||String(e), sync:async()=>{},
  attachRefHint:()=>(()=>{}), registryAssets:()=>[GOLD,EURX], balObj:()=>({ [GOLD]: 2000000000n, [EURX]: 2000000000n }), btcBalance:0,
};
const SUBAS_CAPABLE = {
  btcLeg:{ fund:async()=>({}), refund:async()=>({}), refundKey:()=>({}), tipHeight:async()=>0 },
  seqLeg:{ fund:async()=>({}), refund:async()=>({}), refundKey:()=>({}), claim:async()=>({}), claimKey:()=>({}),
    readOutput:async()=>null, findFundingByAddress:async()=>null, tipHeight:async()=>300, htlcAddress:()=>'a', htlcSpkHex:()=>'00', outspend:async()=>({known:false,spent:false}) },
  wasm:{ generateSwapSecret:()=>({secret_hex:'00'.repeat(32),hash_hex:'11'.repeat(32)}), buildSeqHtlcRedeemScript:()=>'00' },
};
const swap = await import('./swap.js');
swap.initSwap({ ...C, ...SUBAS_CAPABLE,
  ln:{ available:()=>true, deployed:()=>true, status:async()=>({channels:[]}), unifiedBook:async()=>null,
    swap:async()=>({}), assetNodeKey:async()=>'k', nodeInvoice:async()=>({}), invoiceStatus:async()=>({}), nodeSettle:async()=>({}), book:async()=>({}) } });
const T = swap.__test__;

// 1) orientation guard: a wrong-direction row (offers GOLD, wants EURX) must not price a GOLD->EURX sell.
{
  const wrongWay = { offer_asset: GOLD, want_asset: EURX, offer_amount: '100000', want_amount: '380000000' };
  assert.equal(T.bestReceivePerPay([wrongWay], GOLD, EURX), null,
    'a pool holding only a wrong-direction row yields NO price (was: an inverted 1/3846)');
  const rightWay = { offer_asset: EURX, want_asset: GOLD, offer_amount: '380000000', want_amount: '100000' };
  const p = T.bestReceivePerPay([wrongWay, rightWay], GOLD, EURX);
  assert.ok(Math.abs(p - 3800) < 1e-6, 'the right-direction row prices at 3800 receive-per-pay, wrong-direction skipped');
  // legacy rows without leg assets keep the caller-filtered behavior
  const legacy = { offer_amount: '380000000', want_amount: '100000' };
  assert.ok(Math.abs(T.bestReceivePerPay([legacy], GOLD, EURX) - 3800) < 1e-6, 'a legacy row (no leg assets) still prices');
  console.log('ok: bestReceivePerPay orientation guard');
}

// 2) full requoteMixed sell path: pay 0.001 GOLD over LN -> receive 3.8 EURX on-chain, Review enabled.
{
  T.setFeeState({ payAsset: GOLD, receiveAsset: EURX, payRail: 'ln', recvRail: 'chain', edited: 'pay', mode: 'take' });
  REG.swPayAmt = mkEl('input'); REG.swRecvAmt = mkEl('input'); REG.swPriceAmt = mkEl('input');
  REG.swPayAmt.value = '0.001';
  T.setSubassetBook(GOLD, { sell_available:true, buy_available:false, ts: Date.now(),
    sell_offers:[{ offer_id:'m1', maker_pubkey:'03'.padEnd(66,'b'), ln_direction:5, asset_amount:100000, btc_sats:380000000,
      min_fill:0, maker_ln_node:'02'.padEnd(66,'c'), onchain_cltv:180, expires_at: Math.floor(Date.now()/1000)+1800, interactive:false }],
    buy_offers:[] }, EURX);
  const route = { kind:'mixed', seqAsset:GOLD, payIsBtc:false, mixedSame:true, quoteAsset:EURX, payRail:'ln', recvRail:'chain', assetAsset:false };
  await T.requoteMixed(route, '0.001');
  assert.equal(REG.swRecvAmt.value, '3.8', 'receive derives pay x price (3.8 EURX), never pay / price');
  const lq = T.lastQuote();
  assert.ok(lq && String(lq.takeAssetAtoms) === '100000' && String(lq.takeBtcSats) === '380000000',
    'the sized take carries the offer-consistent amounts (Review == execution)');
  console.log('ok: mixed same-chain SELL derives receive = pay x price and enables Review');
}
