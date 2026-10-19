// The check before a hosted node completes a channel with the wallet's own funding transaction:
// what `decodepsbt` must show for the node to ask its peer for the first commitment.
import { test } from 'node:test';
import assert from 'node:assert';
import { amountAtoms, fundingProblem, btcFundingProblem, fundingTxidOf } from './external-funding.mjs';

const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1';
const SEQ = '4d1b177ce67c24263c8a8f756b4e3525ec16fa5dd225e333c1d2d3d3ffe5e57f';
const SCRIPT = '0020' + '0b'.repeat(32);
const ATOMS = 150_000_000;

// The output shapes Sequentia's decodepsbt prints for a PSET v2: an explicit output has amount,
// asset and script; a blinded one keeps them beside its commitments and proofs; the fee output
// has an empty script.
const toChannel = (over = {}) => ({ amount: 1.5, script: { hex: SCRIPT, type: 'witness_v0_scripthash' }, asset: GOLD, ...over });
const blindedChange = (over = {}) => ({ amount: 3.2, script: { hex: '0014' + '2a'.repeat(20) }, asset: GOLD,
  value_commitment: '08' + 'aa'.repeat(32), asset_commitment: '0a' + 'bb'.repeat(32),
  rangeproof: 'cc', surjection_proof: 'dd', blinding_pubkey: '02' + 'ee'.repeat(32), blinder_index: 0, ...over });
const fee = { amount: 0.0000025, script: { hex: '' }, asset: GOLD };
const tx = (...outputs) => ({ outputs });
const want = { script: SCRIPT, atoms: ATOMS, asset: GOLD };

test('a blinded transaction paying the channel exactly, in the clear, may fund it', () => {
  assert.equal(fundingProblem(tx(toChannel(), blindedChange(), fee), want), null);
  // whatever the output order, and the script and asset in any case
  assert.equal(fundingProblem(tx(fee, blindedChange(), toChannel({ asset: GOLD.toUpperCase() })),
    { ...want, script: SCRIPT.toUpperCase() }), null);
});

test('the policy asset is checked like any other asset', () => {
  assert.equal(fundingProblem(tx(toChannel({ asset: SEQ }), fee), { ...want, asset: SEQ }), null);
  assert.match(fundingProblem(tx(toChannel({ asset: SEQ }), fee), want), /another asset/);
});

test('a payment to the channel worth less, or more, than the channel is refused', () => {
  assert.match(fundingProblem(tx(toChannel({ amount: 0.75 }), fee), want), /75000000 atoms, not the channel's 150000000/);
  assert.match(fundingProblem(tx(toChannel({ amount: 1.50000001 }), fee), want), /150000001 atoms/);
});

test('a payment in another asset, or with no asset, is refused', () => {
  assert.match(fundingProblem(tx(toChannel({ asset: SEQ }), fee), want), /another asset/);
  const noAsset = toChannel(); delete noAsset.asset;
  assert.match(fundingProblem(tx(noAsset, fee), want), /another asset \(none\)/);
});

test('a confidential payment to the channel is refused: its amount would be the payer\'s word', () => {
  assert.match(fundingProblem(tx(toChannel({ value_commitment: '08' + 'aa'.repeat(32) }), fee), want), /confidential/);
  assert.match(fundingProblem(tx(toChannel({ asset_commitment: '0a' + 'bb'.repeat(32) }), fee), want), /confidential/);
  assert.match(fundingProblem(tx(toChannel({ blinding_pubkey: '02' + 'ee'.repeat(32) }), fee), want), /confidential/);
});

test('a transaction not yet blinded is refused: blinding it would change the txid', () => {
  const unblinded = blindedChange(); delete unblinded.value_commitment; delete unblinded.asset_commitment;
  assert.match(fundingProblem(tx(toChannel(), unblinded, fee), want), /not blinded yet/);
});

test('a transaction that does not pay the channel, or pays it twice, is refused', () => {
  assert.match(fundingProblem(tx(blindedChange(), fee), want), /does not pay the channel/);
  assert.match(fundingProblem(tx(toChannel(), toChannel(), fee), want), /more than once/);
  assert.match(fundingProblem({}, want), /could not be read/);
  assert.match(fundingProblem(tx(toChannel()), { ...want, script: '' }), /no funding script/);
});

test('decodepsbt amounts become atoms without float drift', () => {
  assert.equal(amountAtoms(1.5), 150_000_000);
  assert.equal(amountAtoms(0.00000001), 1);
  assert.equal(amountAtoms(0.29), 29_000_000);          // 0.29 * 1e8 = 28999999.999999996
  assert.equal(amountAtoms(21_000_000), 2_100_000_000_000_000);
  assert.equal(amountAtoms('1'), null);
  assert.equal(amountAtoms(-1), null);
});

test('the funding txid is the one the node recorded for that channel', () => {
  const chans = [
    { channel_id: 'aa'.repeat(32), funding_txid: '11'.repeat(32) },
    { channel_id: 'BB'.repeat(32), funding: { txid: '22'.repeat(32) } },
  ];
  assert.equal(fundingTxidOf(chans, 'aa'.repeat(32)), '11'.repeat(32));
  assert.equal(fundingTxidOf(chans, 'bb'.repeat(32)), '22'.repeat(32));
  assert.equal(fundingTxidOf(chans, 'cc'.repeat(32)), null);
  assert.equal(fundingTxidOf([{ channel_id: 'aa'.repeat(32), funding_txid: 'xyz' }], 'aa'.repeat(32)), null);
});

// bitcoind's decodepsbt of a PSBT v0: the unsigned transaction under `tx`, amounts in BTC.
const btcTx = (...vout) => ({ tx: { txid: 'ab'.repeat(32), vout } });
const btcOut = (value, hex) => ({ value, n: 0, scriptPubKey: { hex, type: 'witness_v0_scripthash' } });
const btcWant = { script: SCRIPT, sats: 250_000 };

test('a Bitcoin funding paying the channel exactly may fund it', () => {
  assert.equal(btcFundingProblem(btcTx(btcOut(0.0025, SCRIPT), btcOut(0.01, '0014' + '2a'.repeat(20))), btcWant), null);
});

test('a Bitcoin funding paying the channel less, twice, or not at all is refused', () => {
  assert.match(btcFundingProblem(btcTx(btcOut(0.002, SCRIPT)), btcWant), /200000 sats, not the channel's 250000/);
  assert.match(btcFundingProblem(btcTx(btcOut(0.0025, SCRIPT), btcOut(0.0025, SCRIPT)), btcWant), /more than once/);
  assert.match(btcFundingProblem(btcTx(btcOut(0.0025, '0014' + '2a'.repeat(20))), btcWant), /does not pay the channel/);
  assert.match(btcFundingProblem({ outputs: [] }, btcWant), /could not be read/);
});
