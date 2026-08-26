// Classic message signing: the "Bitcoin Signed Message" format that `verifymessage`
// accepts, so a signature made here can be checked by anyone with a node and no
// knowledge of this wallet. It is the key-derived alternative to the tagged OpenAMP
// signatures on the Sign tab: those prove control of an enclave account id, this
// proves control of an address.
//
// The format is a hash of the magic string and the message, each length-prefixed,
// hashed twice with SHA-256, signed with recoverable ECDSA, and base64-encoded as
// [header][r][s] where header = 27 + recovery id + 4 for a compressed key
// (src/util/message.cpp in the node).
//
// Sequentia's testnet keeps Bitcoin testnet's P2PKH version byte, so ONE signature
// verifies on sequentiad and on a Bitcoin node alike — which is what a wallet whose
// address is valid on both chains should produce. Verification takes the P2PKH form
// of the address: MessageVerify rejects anything that is not a PKHash destination,
// bech32 included, so a wallet that only ever shows tb1 must hand the verifier the
// legacy form of the same key.
import { secp256k1, sha256, btc } from './btc.js';

const MESSAGE_MAGIC = 'Bitcoin Signed Message:\n';

function varInt(n){
  if(n < 0xfd) return Uint8Array.of(n);
  if(n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  if(n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  throw new Error('message too long to sign');
}
// A string as the node's serializer writes it: CompactSize length, then the bytes.
function serString(s){
  const b = new TextEncoder().encode(s);
  const len = varInt(b.length);
  const out = new Uint8Array(len.length + b.length);
  out.set(len, 0); out.set(b, len.length);
  return out;
}
export function messageHash(message){
  const magic = serString(MESSAGE_MAGIC), body = serString(message);
  const buf = new Uint8Array(magic.length + body.length);
  buf.set(magic, 0); buf.set(body, magic.length);
  return sha256(sha256(buf));
}

// Sign `message` with a 32-byte secret key. Returns the base64 signature.
export function signMessage(secretKey, message){
  // prehash:false — this bundle's sign() hashes its input by default, which would
  // sign sha256(messageHash) and produce a signature no node accepts.
  const rec = secp256k1.sign(messageHash(message), secretKey, { format: 'recovered', prehash: false });   // [recid, r(32), s(32)]
  const sig = new Uint8Array(65);
  sig[0] = 27 + rec[0] + 4;        // +4: the key is compressed, which is all this wallet derives
  sig.set(rec.subarray(1), 1);
  return btoa(String.fromCharCode(...sig));
}

// The compressed public key that signed `message`, or null if the signature is malformed.
export function recoverPubkey(message, signatureB64){
  let sig;
  try{ sig = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0)); }catch{ return null; }
  if(sig.length !== 65) return null;
  const header = sig[0];
  if(header < 27 || header > 34) return null;
  const recovered = new Uint8Array(65);
  recovered[0] = (header - 27) & 3;
  recovered.set(sig.subarray(1), 1);
  try{
    return secp256k1.Signature.fromBytes(recovered, 'recovered')
      .recoverPublicKey(messageHash(message)).toBytes(true);
  }catch{ return null; }
}

// The address a verifier must be given: the P2PKH form of this key. `network` is a
// btc.js network descriptor (btc.TEST_NETWORK for Sequentia testnet and testnet4 both).
export function verifyAddress(publicKey, network){ return btc.p2pkh(publicKey, network).address; }

// Check a signature the way the node does: recover the key, then require it to hash
// to the SAME P2PKH address the verifier was given.
export function verifyMessage(message, signatureB64, address, network){
  const pub = recoverPubkey(message, signatureB64);
  if(!pub) return false;
  try{ return verifyAddress(pub, network) === address; }catch{ return false; }
}
