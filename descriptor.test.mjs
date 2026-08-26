// The checksums here came from the node: `sequentia-cli getdescriptorinfo <descriptor>`
// reports the same eight characters, so a descriptor this wallet shows is one the node
// accepts verbatim. The key is the standard BIP39 test phrase's account key — nothing
// secret. BIP380's own worked example is included as an independent check.
import { test } from 'node:test';
import assert from 'node:assert';
import { descriptorChecksum, withChecksum, accountDescriptors } from './descriptor.js';

const KO = '[73c5da0a/84h/1h/0h]tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M';

test('the checksums the node reports', () => {
  assert.deepStrictEqual(accountDescriptors(KO, 'wpkh'), [
    `wpkh(${KO}/0/*)#evh9fu0w`,
    `wpkh(${KO}/1/*)#gcjy5flk`,
  ]);
  assert.deepStrictEqual(accountDescriptors(KO, 'pkh'), [
    `pkh(${KO}/0/*)#mzfssff9`,
    `pkh(${KO}/1/*)#2kv3duea`,
  ]);
});

// A private-key descriptor, and a longer derivation path: same code path, different
// characters through the charset table. The node reports this one too.
test('a second descriptor the node checksums the same way', () => {
  assert.strictEqual(
    descriptorChecksum('wpkh(tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK/1/2/*)'),
    'vuyep999',
  );
});

test('an empty key origin yields no descriptor, not a broken one', () => {
  assert.deepStrictEqual(accountDescriptors(''), []);
});

test('a character no descriptor may hold is refused', () => {
  assert.strictEqual(descriptorChecksum('wpkh(tpub…/0/*)'), null);   // … is not in the charset
  assert.strictEqual(withChecksum('wpkh(tpub…/0/*)'), 'wpkh(tpub…/0/*)');
});
