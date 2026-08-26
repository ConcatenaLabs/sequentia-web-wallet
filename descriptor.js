// Output descriptors for the wallet's account key, in the form another wallet can import.
//
// A descriptor without its checksum is refused by the RPCs that matter (importdescriptors
// takes one, deriveaddresses takes one), so these are emitted WITH it. The checksum is
// BIP380's: a BCH code over the descriptor string, 8 characters after a '#'.
//
// Both chains derive from one m/84'/1'/0' account, so one key yields both forms below.
// wpkh() describes what this wallet actually hands out — the tb1 addresses valid on
// Sequentia and Bitcoin alike. pkh() describes the legacy form of the same key: nothing
// here spends to it, but it is the address a node's verifymessage takes, so a descriptor
// for it is what a counterparty imports to watch or check one.

const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(c, val){
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i];
  return c;
}

// The 8-character checksum for `desc`, or null if it holds a character no descriptor may.
export function descriptorChecksum(desc){
  let c = 1n, cls = 0, clscount = 0;
  for (const ch of desc){
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos < 0) return null;
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3){ c = polymod(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - i))) & 31n)];
  return out;
}

export function withChecksum(desc){
  const sum = descriptorChecksum(desc);
  return sum ? desc + '#' + sum : desc;
}

// `keyorigin` is the "[fingerprint/84h/1h/0h]tpub..." string a signer reports. Returns the
// PAIR a wallet imports — receive (/0/*) then change (/1/*) — rather than one multipath
// `<0;1>` descriptor: sequentiad answers "Key path value '<0;1>' is not a valid uint32",
// so the shorter form would be a string this network's own node refuses.
export function accountDescriptors(keyorigin, kind = 'wpkh'){
  if (!keyorigin) return [];
  return [0, 1].map(branch => withChecksum(`${kind}(${keyorigin}/${branch}/*)`));
}
