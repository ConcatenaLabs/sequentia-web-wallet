// Vendored from ConcatenaLabs/sequentia-extension src/psetbytes.js at 5c901e15d1d606e5807da74cd46b9b17cba9934a, unchanged below this line: edit it there, then vendor it again (pset-bytes.test.mjs).
// Reading and trimming a PSET as bytes.
//
// The wallet's own decoder answers most questions, but two it cannot: it
// refuses a fully transparent PSET (it looks for blinding that is not there),
// and it has no way to hand back a document with this wallet's key origins
// removed. Both matter when a website builds the transaction: a covenant fill
// is transparent by necessity, and the origins are the wallet's business, not
// the site's.
//
// Everything here walks the PSET v2 key/value maps and nothing else. The key
// types are the ones the node writes: globals 0x04/0x05 (input and output
// counts), input 0x01 (witness utxo) and 0x06 (key origin), output 0x03
// (amount), 0x04 (script), 0x02 (key origin), and the Elements proprietary
// key 0xfc "pset" 0x02 (asset).

const MAGIC = [0x70, 0x73, 0x65, 0x74, 0xff];

function b64ToBytes(b64) {
  const bin = atob(b64.trim()); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64(a) {
  let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function hex(bytes) {
  let s = ''; for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// A cursor over the maps: [global, input..., output...].
function reader(b) {
  let i = 0;
  const varint = () => {
    const x = b[i++];
    if (x < 0xfd) return x;
    if (x === 0xfd) { const v = b[i] | (b[i + 1] << 8); i += 2; return v; }
    if (x === 0xfe) { const v = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; i += 4; return v; }
    let v = 0; for (let k = 0; k < 8; k++) v += b[i + k] * Math.pow(2, 8 * k); i += 8; return v;
  };
  return {
    get pos() { return i; },
    set pos(v) { i = v; },
    varint,
    map() {
      const entries = [];
      for (;;) {
        const klen = varint();
        if (klen === 0) return entries;
        const key = b.slice(i, i + klen); i += klen;
        const vlen = varint();
        const val = b.slice(i, i + vlen); i += vlen;
        entries.push([key, val]);
      }
    },
  };
}

function leNumber(bytes) {
  let v = 0;
  for (let k = 0; k < bytes.length; k++) v += bytes[k] * Math.pow(2, 8 * k);
  return v;
}
function leBig(bytes) {
  let v = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[k]);
  return v;
}
function beBig(bytes) {
  let v = 0n;
  for (const x of bytes) v = (v << 8n) | BigInt(x);
  return v;
}

function isPropAsset(key) {
  // 0xfc <varstr "pset"> 0x02
  return key.length === 7 && key[0] === 0xfc && key[1] === 0x04 &&
         key[2] === 0x70 && key[3] === 0x73 && key[4] === 0x65 && key[5] === 0x74 &&
         key[6] === 0x02;
}

// The explicit part of an Elements txout as PSBT_IN_WITNESS_UTXO carries it:
// asset (0x01 + 32 bytes, wire order), value (0x01 + 8 bytes big-endian),
// nonce, script. A commitment instead of either means the output is blinded,
// and this returns null.
function explicitWitnessUtxo(val) {
  if (val.length < 43 || val[0] !== 0x01) return null;
  const asset = hex(val.slice(1, 33).reverse());
  if (val[33] !== 0x01) return null;
  const atoms = beBig(val.slice(34, 42));
  let i = 42;
  i += val[i] === 0x00 ? 1 : 33;                 // nonce
  const r = reader(val.slice(i));
  const n = r.varint();
  const script = hex(val.slice(i + r.pos, i + r.pos + n));
  return { asset, atoms, script };
}

/**
 * What a fully transparent PSET does, from the bytes alone.
 *
 * `mine` on an input or output is the wallet's own key origin, which
 * `Pset.addDetails(wollet)` writes for the scripts this wallet derives, so
 * pass a PSET that has been through it. Amounts are BigInt atoms.
 */
export function describeTransparent(b64) {
  const b = b64ToBytes(b64);
  for (let k = 0; k < 5; k++) if (b[k] !== MAGIC[k]) throw new Error('not a PSET');
  const r = reader(b);
  r.pos = 5;
  const global = r.map();
  let inCount = 0, outCount = 0;
  for (const [key, val] of global) {
    if (key.length === 1 && key[0] === 0x04) inCount = leNumber(val);
    if (key.length === 1 && key[0] === 0x05) outCount = leNumber(val);
  }
  const inputs = [];
  for (let n = 0; n < inCount; n++) {
    const entries = r.map();
    let utxo = null, mine = false;
    for (const [key, val] of entries) {
      if (key.length === 1 && key[0] === 0x01) utxo = explicitWitnessUtxo(val);
      // A key origin is the type byte followed by the public key it belongs
      // to, which is how it is told from a bare key of the same type.
      if (key[0] === 0x06 && key.length > 1) mine = true;
    }
    inputs.push({ ...(utxo || {}), mine, blinded: utxo === null });
  }
  const outputs = [];
  for (let n = 0; n < outCount; n++) {
    const entries = r.map();
    let atoms = null, script = '', asset = null, mine = false;
    for (const [key, val] of entries) {
      if (key.length === 1 && key[0] === 0x03) atoms = leBig(val);
      if (key.length === 1 && key[0] === 0x04) script = hex(val);
      if (key[0] === 0x02 && key.length > 1) mine = true;
      if (isPropAsset(key)) asset = hex(val.slice().reverse());
    }
    outputs.push({ atoms, script, asset, mine, fee: script === '' });
  }
  // What the wallet gains or loses, per asset, and what the fee output pays.
  const deltas = {};
  for (const i of inputs) {
    if (!i.mine || !i.asset) continue;
    deltas[i.asset] = (deltas[i.asset] || 0n) - i.atoms;
  }
  for (const o of outputs) {
    if (!o.mine || !o.asset || o.fee) continue;
    deltas[o.asset] = (deltas[o.asset] || 0n) + o.atoms;
  }
  const feeOut = outputs.find((o) => o.fee);
  return {
    inputs,
    outputs,
    deltas,
    fee: feeOut ? feeOut.atoms : null,
    feeAsset: feeOut ? feeOut.asset : null,
    blindedInputs: inputs.some((i) => i.blinded),
  };
}

/**
 * The same PSET without this wallet's key origins. They say which keys the
 * wallet derives and are nobody else's business; a signature does not need
 * them, and finalising does not either.
 */
export function stripBip32(b64) {
  const b = b64ToBytes(b64);
  for (let k = 0; k < 5; k++) if (b[k] !== MAGIC[k]) throw new Error('not a PSET');
  const out = [...MAGIC];
  const r = reader(b);
  r.pos = 5;
  const emitVarint = (v) => {
    if (v < 0xfd) out.push(v);
    else if (v <= 0xffff) { out.push(0xfd, v & 0xff, (v >> 8) & 0xff); }
    else if (v <= 0xffffffff) { out.push(0xfe, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
    else { out.push(0xff); for (let k = 0; k < 8; k++) out.push(Math.floor(v / Math.pow(2, 8 * k)) & 0xff); }
  };
  const copy = (entries, dropTypes) => {
    for (const [key, val] of entries) {
      if (dropTypes.has(key[0])) continue;
      emitVarint(key.length); for (const x of key) out.push(x);
      emitVarint(val.length); for (const x of val) out.push(x);
    }
    out.push(0x00);
  };
  const global = r.map();
  let inCount = 0, outCount = 0;
  for (const [key, val] of global) {
    if (key.length === 1 && key[0] === 0x04) inCount = leNumber(val);
    if (key.length === 1 && key[0] === 0x05) outCount = leNumber(val);
  }
  copy(global, new Set([0x01]));
  for (let n = 0; n < inCount; n++) copy(r.map(), new Set([0x06]));
  for (let n = 0; n < outCount; n++) copy(r.map(), new Set([0x02]));
  return bytesToB64(Uint8Array.from(out));
}
