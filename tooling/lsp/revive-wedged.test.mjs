// A hosted node that is RUNNING but cannot serve used to be unrecoverable: a keyless
// lightningd needs its device signer to answer RPC at all, and the hsmd proxy accepts only
// the FIRST signer session per lightningd — every later one is handshaken and dropped. So
// provision() saw "RPC does not answer", called it down, and booted a SECOND lightningd,
// which died on the PID lock. The node stayed wedged and the wallet just said it could not
// create the invoice. These cover the two decisions that fix it, and the safety property
// that makes killing processes from a server acceptable at all: nothing is ever matched by
// a loose pattern, only by the node's own directory.
import { test } from 'node:test';
import assert from 'node:assert';
import { matchNodeProcs, relayRunning } from './provision.mjs';

const DIR = '/root/sequentia/lsp/prov/node-USDX-15';
const OTHER = '/root/sequentia/lsp/prov/node-USDX-17';

const table = [
  { pid: 10, cmdline: `/seqln/lightningd --lightning-dir=${DIR} --network=sequentia-testnet --developer` },
  { pid: 11, cmdline: `lightning_hsmd_proxy ${DIR}/sequentia-testnet` },
  { pid: 12, cmdline: `/seqln/cli/lightning-cli --rpc-file=${DIR}/sequentia-testnet/lightning-rpc getinfo` },
  { pid: 20, cmdline: `/seqln/lightningd --lightning-dir=${OTHER} --network=sequentia-testnet` },
  { pid: 30, cmdline: '/usr/bin/node /root/sequentia/sequentia-web-wallet/tooling/lsp/lsp-server.mjs' },
  { pid: 40, cmdline: '/root/Sequentia/src/sequentiad -datadir=/root/seq-testnet/node000' },
  { pid: 50, cmdline: '/usr/bin/node seqln-ws-relay.mjs --ws-port 18915 --tcp 127.0.0.1:9915' },
  // The keyless watchtower. It watches THIS node's netdir, so it carries the directory —
  // and it is nobody's subdaemon. A revive killed it live once; it must not again.
  { pid: 60, cmdline: `/root/sequentia/seqln/speculad/speculad --netdir=${DIR}/sequentia-testnet --network=sequentia-testnet` },
];

test('a node claims its own lightningd, proxy and hung CLIs — and nothing else', () => {
  const m = matchNodeProcs(table, DIR);
  assert.deepStrictEqual(m.lightningd, [10]);
  assert.deepStrictEqual(m.related.sort(), [11, 12]);
});

test('another node, the LSP itself and the chain node are never touched', () => {
  const m = matchNodeProcs(table, DIR);
  const claimed = new Set([...m.lightningd, ...m.related]);
  for (const pid of [20, 30, 40]) assert.ok(!claimed.has(pid), `pid ${pid} must be left alone`);
});

test('the watchtower watching this node survives its revive', () => {
  const m = matchNodeProcs(table, DIR);
  assert.ok(![...m.lightningd, ...m.related].includes(60), 'speculad must not be killed by a node revive');
});

test('a node with nothing running is a cold boot, not a revive', () => {
  const m = matchNodeProcs(table, '/root/sequentia/lsp/prov/node-GOLD-99');
  assert.deepStrictEqual(m.lightningd, []);
  assert.deepStrictEqual(m.related, []);
});

test('an empty directory never claims the whole process table', () => {
  for (const dir of ['', null, undefined]) {
    const m = matchNodeProcs(table, dir);
    assert.deepStrictEqual([...m.lightningd, ...m.related], [], String(dir));
  }
});

test('a live relay is recognised, so re-booting a node stops spawning EADDRINUSE corpses', () => {
  assert.strictEqual(relayRunning(table, 18915), true);
  assert.strictEqual(relayRunning(table, 18920), false);
  // The port must match as a whole argument, not as a prefix of a longer one.
  assert.strictEqual(relayRunning(table, 1891), false);
});
