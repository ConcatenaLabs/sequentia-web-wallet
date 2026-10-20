// ---------------------------------------------------------------------------
// SeqDEX's Simplicity order: the template seqdex/order of sequentia-contracts
// (templates/seqdex_order). One program serves every order; the order's terms
// sit in a data leaf beside it,
//
//   P2TR(NUMS, TapBranch(TapLeaf_0xbe(program), H_TapData(terms)))
//
// so an order's address is the pinned commitment root plus its terms, derived
// here with one hash per leaf and one curve tweak and no compiler, as seqdex's
// Go (daemon/pkg/covenant SimOrder) derives it. Every spend's pruned program is
// a constant of the template, so a fill's witness is built here too:
// [terms || PATH, program, cmr, control block], PATH 0x40 for a partial fill
// and 0x00 for a whole one.
//
// A fill pays the maker at output 2k at least ceil(filled * rate_num /
// rate_den) of asset_b, compared on 128-bit products, so any 64-bit amount and
// price fills; a partial fill rests again at 2k+1 under the same script. The
// refund key takes the coin back once the lock time reaches expiry_locktime.
//
// covenant-sim.test.mjs holds this file to seqdex-order-vectors.json and
// seqdex-order-fills.json, copies of the template's vectors and programs as
// seqdex pins them (daemon/pkg/covenant/seqdex_order/, PIN.json there).
//
// An order object carries the relay's SimplicityCovenantTerms fields, bytes as
// hex: asset_a, asset_b (internal byte order), rate_num, rate_den, min_lot,
// maker_script (the payout scriptPubKey), expiry_locktime, refund_key.
// ---------------------------------------------------------------------------

import { schnorr, sha256 } from './btc.js';

export const SIM_ORDER_TEMPLATE_HASH = '322c0e596e9552a4c20f6a7f9ed518013a50076ec8b2b9005fd032077ebcd157';
export const SIM_ORDER_CMR = 'f9b42b838b6295f4f376760fbb02eed9cb20f872f07ee4b9df7273d26822ee44';
const PROGRAMS = {
  fill: 'e943ba050e8143a050e8143a050e8143a050e81420c38e38e38e38da4e38e38e385a0830e38e38e36671c71c2c86da71c70b11b88ce39061c6e29140b20b505c3483102841861c72050838e38e390284ece8210284186e441871c70b26ab902102836c3f24cc38e38e16603620506e0e6e469871c71c2cdaae00840a0dc467e4c9871c71c70b400da8141b8bcfca530e38e38e38e38e16c01c35028371f9b98638e38e38e38e38e385b40721502837240dcb130e38e38e38e16a6ab4108141b93e7e698c38e38e38e38e16b01ca340a0dcaed588201801c100e24038d80e4381c9403942072b40e5d01cc001cc481cc881ccb13600008f8717821091433a219ce42cf3ffb7c699fcd7d39b9a70e4843427f76e462685308969df9b098b85ce60281985b59b74023008b001070201c012534440d7fa8b066064fc76756c5a00fd4bf77afe303a974c6923ab0d26d3674b2f0601c040c806b740a0fced1f9d4141f9ce3f394283f38e283f38a830542c42d6373848141b9c038e40a129f87030409d026830c40a1b9c1bea08b890338ec9a988ab193bd899f2e152435b976a6659e66f4ad8e1adfcdd0061806013241c61c8141b9fc0ec0284c4fb84c4140dc0709038710283740c986e74ce385800e4701c8d4fc28210283740008d2e20840a0dc81313008160cda0401ca13f40799a63882102836f481b85406d0395a7e4b1c71c71c71c72050ce55755d1320a731b6342aa9629e6c7bf0507865aa08bd59aca45d9b370bf381c6e1077c3403a0a8848a1060798a03003404e833372710283742e87938050989b932720506e8540f2900a1313ec3f4221c77c350200e6845ac2d006a038181c2c0e2720506e87830fc9d38e38e164039af039ae3f4411c627e1c10102c0073700736e7e3df869074339091420c0f38e060068245903cdff37c08062039c848a0fd16a0807051ba0ace38e38e38e38e3744d1c60b069c0320401cef1fa284c38e38e384d82e85ce850d34640813a22cdce9989039921501cc881cf89fa2d0c151fa2dc100da07020b8580c45c5c033172180691724406b072741e6240e62c2731a7e30374640a00e2c03a025366000000000000000008133d380e40803a040fcd71c072c9028372c4dd12e71c71c71c70b480e82203a084dcb23747b1c71c71c71c71c70b600e83103a0c0fc3c0e531f8b4dd15271c71c71c2d0d36e40837294dd15071c71c71c2d00358b58dd1d4274874fd1d8720506e8b83745c9c2a039568141b9566e8cc38dd19c71c2c02cda679021028372dd2074040a80e80703a19c4c40e6781a40e0c070e0388c0e2624500734c2e4000e6a05c8401cd50b92a039ac0728c2e5480e6bc5cb201cd8839721740880e6d01d0321741000e6dc1d0560741905d070039bb0742101d0c80743501d0dc64216360e44682ffd4e26ae204aac015e6cf1f869ccaa8815fcae4701abbe18cb0c03a1fc2744e81ce20ba2140738c2e89101ce403a4d00749b00e93801d27403a4f00749f00e94001d2840',
  fill_whole: 'e927ba050e8143a050e8143a050e8143a050e81420c38e38e38e38da4e38e38e385a0830e38e38e36671c71c2c86da71c70b11b88ce39061c6e29140b20b505c3483102841861c72050838e38e390284ece8210284186e441871c70b26ab902102836c3f24cc38e38e16603620506e0e6e469871c71c2cdaae00840a0dc467e4c9871c71c70b400da8141b8bcfca530e38e38e38e38e16c01c35028371f9b98638e38e38e38e38e385b40721502837240dcb130e38e38e38e16a6ab4108141b93e7e698c38e38e38e38e16b01ca340a0dcaed588201801c100e24038d80e4381c9403942072b40e5d01cc001cc481cc881ccb13600008f8717821091433a219ce42cf3ffb7c699fcd7d39b9a70e4843427f76e462685308969df9b098b85ce60281985b59b74023008b001070201c012534440d7fa8b066064fc76756c5a00fd4bf77afe303a974c6923ab0d26d3674b2f0601c040c806b740a0fced1f9d4141f9ce3f394283f38e283f38a830542c42d6373848141b9c038e40a129f87030409d026830c40a1b9c1bea08b890338ec9a988ab193bd899f2e152435b976a6659e66f4ad8e1adfcdd0061806013241c61c8141b9fc0ec0284c4fb84c4140dc0709038710283740c986e74ce385800e4701c8d4fc28210283740008d2e20840a0dc81313008160cda0401ca13f40799a63882102836f481b85406d0395a7e4b1c71c71c71c720507e83b30e38e39bb576ea2c7890f07ed99dd1c17e4e74174d89f6f362a96220ef1f880190468738300d21359b9e038e38e38e38e374270a34e0190200e64136600000000000000000813469c0720401ccb9f8d4ef868074241091420c0f35006006809d0a26e5d20506e87b0f2e80a131372dce40a0dd0e41e6080a1313ec3f4311c77c350200e6fc5ac2d006a038181c2c0e2720506e89630dd08a71c71c71c70b480e7400e73cfd1467186e8a638e38e38e38e38e16c01cf081cf01f911f0d20e890212284181e7c00c00d048b2079e8e79c100c4073e29141fa378100e0a3f2acdd0da71c71c71c2d0d36e408374621c61ba1b8e38e38e385a006d16d1ba2c04e8e33f4591c8141ba1f8dd0fe70ab4d1902102837402986e89438dd12c71c2c02cda67902102836d481ce80a80e73c0e82f131038f41a40e0e071001c4a071412280390a2e4200e438b938039122e5780e458397c173540391c2e6cc072401ce185cec80e49839e10b9e801c96073e6073f41740000e4d03a0280e82c03a0c80e8363210b1b07223417fea7135710255600af3678fc34e655440afe572380d5df0c658601d08e13a1940e518ba134072945d0b20394e0e91801d23403a4700748f00e92001d24403a4900749300',
  refund_height: 'e82f740a1d028740a1d028740a1d028740a1d02841871c71c71c71b49c71c71c70b41061c71c71c6cce38e38590db4e38e16237119c720c38dc522816416a0b869062050830c38e40a1071c71c720509d9d042050830dc8830e38e164d5720420506d87e499871c71c2cc06c40a0dc1cdc8d30e38e3859b55c0108141b88cfc9930e38e38e16801b502837179f94a61c71c71c71c71c2d80386a0506e3f3730c71c71c71c71c71c70b680e42a0506e481b96261c71c71c71c2d4d568210283727cfcd31871c71c71c71c2d6039468141b95dab104030038201c48071b01c8703928072840e5681cba0398003989039910399626c00011f0e2f04212286744339c859e7ff6f8d33f9afa73734e1c908684feedc8c4d0a6112d3bf3613170b9cc050330b6b36e804601160020e04038024a68881aff5160cc0c9f8ecead8b401fa97eef5fc60752e98d247561a4da6ce965e0c038081900d6e814334c603f0544e47d5c82b9109f2328d18dcb970e3df1d567c52527c010924da569f9bb3f376e28160373849b21dcd6500040b069c071042050c4cdbdf0a752c0a40867dd099c1d0946a32ae3138fb8ff1a0832a987d0b4061f47d5e0101c00c86e7dcee03808547e738e156c60204e107e819040b700a0e1e0f1281c4e1390a068171680d42e3901b01d0200740a01d0300740e01d0400741201d0500741600',
  refund_time: 'e82f740a1d028740a1d028740a1d028740a1d02841871c71c71c71b49c71c71c70b41061c71c71c6cce38e38590db4e38e16237119c720c38dc522816416a0b869062050830c38e40a1071c71c720509d9d042050830dc8830e38e164d5720420506d87e499871c71c2cc06c40a0dc1cdc8d30e38e3859b55c0108141b88cfc9930e38e38e16801b502837179f94a61c71c71c71c71c2d80386a0506e3f3730c71c71c71c71c71c70b680e42a0506e481b96261c71c71c71c2d4d568210283727cfcd31871c71c71c71c2d6039468141b95dab104030038201c48071b01c8703928072840e5681cba0398003989039910399626c00011f0e2f04212286744339c859e7ff6f8d33f9afa73734e1c908684feedc8c4d0a6112d3bf3613170b9cc050330b6b36e804601160020e04038024a68881aff5160cc0c9f8ecead8b401fa97eef5fc60752e98d247561a4da6ce965e0c038081900d6e814334c603f0544e47d5c82b9109f2328d18dcb970e3df1d567c52527c010924da569f9bb3f376e28160373849b21dcd6500040b069c0710420507d3e404338ea64155c80ecc50c878eba5f2fc9576961950d558930e79f4e516701e83a36060190dcfb9dc07010a8fce71c2ad8c0409c20fd0320816e0141c3c1e250389c272140d02e2d01a85c7203603a0400e81403a0600e81c03a0800e82403a0a00e82c00',
};
export const SIM_ORDER_PROGRAMS = PROGRAMS;

const NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
const LEAF_VERSION = 0xbe;

function bytesToHex(a){ let s = ''; for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s; }
function hexToBytes(h){
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('not hex: ' + h);
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function concat(...arrs){ let n = 0; for (const a of arrs) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of arrs){ out.set(a, o); o += a.length; } return out; }
function cmp(a, b){ for (let i = 0; i < a.length; i++){ if (a[i] !== b[i]) return a[i] - b[i]; } return 0; }
function beBytes(v, len){ let n = BigInt(v); const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--){ out[i] = Number(n & 0xffn); n >>= 8n; } if (n) throw new Error(v + ' does not fit ' + len + ' bytes'); return out; }
function bigOf(b){ let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; }
function taggedHash(tag, ...data){ const t = sha256(new TextEncoder().encode(tag)); return sha256(concat(t, t, ...data)); }
function bytesOf(v, n, what){ const b = typeof v === 'string' ? hexToBytes(v) : Uint8Array.from(v || []); if (n && b.length !== n) throw new Error(what + ' must be ' + n + ' bytes'); return b; }

// simOrderTerms is the data leaf: the terms in the template's order, big-endian.
export function simOrderTerms(o){
  return concat(
    bytesOf(o.asset_a, 32, 'asset_a'), bytesOf(o.asset_b, 32, 'asset_b'),
    beBytes(o.rate_num, 8), beBytes(o.rate_den, 8), beBytes(o.min_lot, 8),
    sha256(bytesOf(o.maker_script, 0, 'maker_script')),
    beBytes(o.expiry_locktime, 4), bytesOf(o.refund_key, 32, 'refund_key'));
}

// deriveSimTerms is the output of the order whose data leaf is terms (156 bytes).
export function deriveSimTerms(terms){
  if (terms.length !== 156) throw new Error('terms of ' + terms.length + ' bytes, not 156');
  const program = taggedHash('TapLeaf/elements', Uint8Array.of(LEAF_VERSION, 0x20), hexToBytes(SIM_ORDER_CMR));
  const data = taggedHash('TapData', terms);
  const [lo, hi] = cmp(program, data) <= 0 ? [program, data] : [data, program];
  const root = taggedHash('TapBranch/elements', lo, hi);
  const P = schnorr.utils.lift_x(bigOf(NUMS));
  const t = schnorr.Point.Fn.create(bigOf(taggedHash('TapTweak/elements', NUMS, root)));
  const { x, y } = P.add(schnorr.Point.BASE.multiply(t)).toAffine();
  const outputKey = beBytes(x, 32);
  const parity = (y & 1n) ? 1 : 0;
  return {
    terms, programLeafHash: program, termsLeafHash: data, merkleRoot: root, outputKey, parity,
    spk: concat(Uint8Array.of(0x51, 0x20), outputKey),
    controlBlock: concat(Uint8Array.of(LEAF_VERSION | parity), NUMS, data),
  };
}

export function deriveSimOrder(o){ return deriveSimTerms(simOrderTerms(o)); }

// simFillWitness is the order input's witness stack (hex) for a fill.
export function simFillWitness(o, partial){
  const d = deriveSimOrder(o);
  return [bytesToHex(d.terms) + (partial ? '40' : '00'), partial ? PROGRAMS.fill : PROGRAMS.fill_whole,
    SIM_ORDER_CMR, bytesToHex(d.controlBlock)];
}

// --- bech32m (BIP350), for the order's address under a chain's prefix -----------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values){
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values){
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
export function simOrderAddress(outputKey, hrp){
  const words = [1];
  let acc = 0, bits = 0;
  for (const x of outputKey){ acc = ((acc << 8) | x) & 0xfff; bits += 8; while (bits >= 5){ bits -= 5; words.push((acc >>> bits) & 31); } }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const pre = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  const mod = polymod(pre.concat(words, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const check = [];
  for (let i = 0; i < 6; i++) check.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + words.concat(check).map(w => CHARSET[w]).join('');
}
