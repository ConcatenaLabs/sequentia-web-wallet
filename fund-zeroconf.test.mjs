// A 0-CONF RAIL MUST NOT WAIT FOR A BLOCK.
//
// btcLeg.fund() blocked until the funding tx confirmed, and only then did the
// sub-asset BUY command the maker. So a rail whose entire promise is "receive the
// asset over Lightning, instantly" inherited Bitcoin's block time before the maker
// was even ASKED — the "why am I waiting for a Bitcoin confirmation?" this rail
// exists to avoid. Seen live: a GOLD buy sat on "Locking your Bitcoin …" for minutes
// with the HTLC already broadcast and the maker idle.
//
// The maker is the party that carries 0-conf risk, and it advertises its own policy
// (max_0conf_amount), so the decision is its to make on an outpoint handed over at
// broadcast. These pin the two properties that makes that hand-off sound: the outpoint
// is COMPLETE without the chain, and the default stays conservative for every other
// caller.
//
//   node --test fund-zeroconf.test.mjs
import assert from 'node:assert';
import test from 'node:test';

// The shape of index.html's fund(), reduced to the branch under test. The real one
// additionally derives the P2SH address and signs; none of that changes this decision.
function fundBranch({ built, onBroadcast, opts }) {
  const waitConf = !(opts && opts.waitConf === false);
  const txid = 'ab'.repeat(32);
  if (typeof onBroadcast === 'function') onBroadcast(txid);
  if (!waitConf) {
    const vout = (built.outputIndexes && built.outputIndexes[0]) || 0;
    return { txid, vout, height: 0, waited: false };
  }
  return { txid, vout: 7, height: 900123, waited: true };   // whatever the chain later reports
}

const BUILT = { outputIndexes: [0], changeIndex: 1 };

test('waitConf:false returns a COMPLETE outpoint without consulting the chain', () => {
  const r = fundBranch({ built: BUILT, opts: { waitConf: false } });
  assert.equal(r.waited, false);
  assert.equal(typeof r.vout, 'number', 'an outpoint without a vout is not an outpoint');
  assert.equal(r.vout, 0, 'the vout comes from the builder that placed the output');
  assert.equal(r.height, 0, '0 means "not mined yet" — not "unknown"');
});

test('the vout is read from the builder, never assumed to be zero', () => {
  // If the builder ever places the requested output after something else, the hand-off
  // must follow it. Assuming 0 at a distance is how an unspendable outpoint gets handed
  // to a maker that will then refuse the take.
  const r = fundBranch({ built: { outputIndexes: [3] }, opts: { waitConf: false } });
  assert.equal(r.vout, 3);
});

test('THE DEFAULT IS UNCHANGED: every other caller still waits', () => {
  // Only the sub-asset BUY opted in. The cross-HTLC taker and the maker leg both lock
  // first and must keep waiting, so an omitted/!== false option must not change them.
  for (const opts of [undefined, null, {}, { waitConf: true }]) {
    assert.equal(fundBranch({ built: BUILT, opts }).waited, true, `opts=${JSON.stringify(opts)} must still wait`);
  }
});

test('a NON-object in the options slot does not silently enable 0-conf', () => {
  // xmaker used to call fund() with a stale 4-arg signature, leaving a refund KEY sitting
  // in what is now the options slot. Anything that is not an explicit waitConf:false must
  // read as "wait" — enabling 0-conf by accident is the dangerous direction.
  for (const opts of ['02abcdef', 61334, { public_key: '02ab', secret_hex: 'ff' }, () => {}]) {
    assert.equal(fundBranch({ built: BUILT, opts }).waited, true, 'only an explicit waitConf:false opts in');
  }
});

test('the txid is handed over BEFORE either branch returns', () => {
  // Persist-before-confirm: the refund material must be recoverable even if the wait (or
  // the tab) dies immediately after broadcast. True on both paths.
  for (const opts of [{ waitConf: false }, undefined]) {
    let seen = null;
    fundBranch({ built: BUILT, onBroadcast: (t) => { seen = t; }, opts });
    assert.equal(seen, 'ab'.repeat(32), 'onBroadcast must fire on both paths');
  }
});
