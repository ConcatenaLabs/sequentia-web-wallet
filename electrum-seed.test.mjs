// Electrum seed import: the kit's Electrum signer and the Bitcoin side's keys
// (HDKey from Signer.electrumSeedHex at m/0') must give Electrum's own addresses,
// and both chains must share the m/0' account.
//
// Needs the kit's pkg/ (see CLAUDE.md); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HDKey, btc } from './btc.js';

const WASM = new URL('./pkg/lwk_wasm_bg.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'needs pkg/ (the lwk_wasm build)';
const TESTNET_BIP32_VERSIONS = { private: 0x04358394, public: 0x043587cf };

// Electrum's tests/test_wallet_vertical.py
const SEGWIT = 'bitter grass shiver impose acquire brush forget axis eager alone wine silver';
const STANDARD = 'cycle rocket west magnet parrot shuffle foot correct salt library feed song';
const BIP39 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

test('Electrum seeds: detection, keys and addresses', { skip }, async () => {
  const lwk = await import('./pkg/lwk_wasm.js');
  lwk.initSync({ module: readFileSync(WASM) });
  const { Signer, Network } = lwk;

  assert.equal(Signer.electrumSeedType(SEGWIT), 'segwit');
  assert.equal(Signer.electrumSeedType(STANDARD), 'standard');
  assert.equal(Signer.electrumSeedType(BIP39), undefined);

  // The Bitcoin side, as index.html's btcInit() builds it for an Electrum wallet.
  const root = HDKey.fromMasterSeed(hexToBytes(Signer.electrumSeedHex(SEGWIT, '')));
  const addr = (path) => btc.p2wpkh(root.derive(path).publicKey).address;
  assert.equal(addr("m/0'/0/0"), 'bc1q3g5tmkmlvxryhh843v4dz026avatc0zzr6h3af');
  assert.equal(addr("m/0'/1/0"), 'bc1qdy94n2q5qcp0kg7v9yzwe6wvfkhnvyzje7nx2p');

  // The Sequentia side: the signer's descriptor sits at the same m/0' account.
  const signer = Signer.fromElectrumSeed(SEGWIT, '', Network.testnet());
  assert.equal(signer.electrumType, 'segwit');
  const tpub = HDKey.fromMasterSeed(hexToBytes(Signer.electrumSeedHex(SEGWIT, '')), TESTNET_BIP32_VERSIONS)
    .derive("m/0'").publicExtendedKey;
  assert.equal(signer.electrumKeyoriginXpub(), `[${signer.fingerprint()}/0h]${tpub}`);
  // The parsed descriptor writes hardened steps as 0'.
  assert.ok(signer.wpkhSlip77Descriptor().toString().replaceAll("'", 'h').includes(`elwpkh([${signer.fingerprint()}/0h]${tpub}/<0;1>/*)`));

  // Standard (p2pkh) and 2FA seeds have no wallet here.
  assert.throws(() => Signer.fromElectrumSeed(STANDARD, '', Network.testnet()).wpkhSlip77Descriptor());
  assert.throws(() => Signer.fromElectrumSeed(BIP39, '', Network.testnet()));
});
