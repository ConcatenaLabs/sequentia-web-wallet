// Hosted nodes outlive an LSP restart (provision.mjs scopePlan/hostedCommand).
//
// Under systemd a restart stops every process in the service's control group, detached or not.
// The provisioner therefore starts each hosted lightningd and relay in a transient scope of its own
// when the LSP runs as a systemd service as root, and as plain detached children anywhere else.
//
// Part 1 checks that choice and the command it builds. Part 2, where this user has a systemd
// manager (`systemctl --user`), runs it for real: a stand-in LSP service provisions three nodes
// (stand-in lightningd and relay scripts), is restarted, and must find the same three processes of
// each kind running and re-attach all three. The same run with scopes off is the control: the
// restart must take every node down. Without a user manager part 2 is skipped, and says so.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopePlan, hostedCommand } from './provision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const yes = () => true;

// --- Part 1: the choice -------------------------------------------------------------------
const svc = { INVOCATION_ID: 'abc' };
assert.equal(scopePlan({ env: { LSP_NODE_SCOPE: '0', ...svc }, uid: 0, exists: yes, probe: yes }).scope, false, 'LSP_NODE_SCOPE=0 turns scopes off');
assert.equal(scopePlan({ env: svc, uid: 0, exists: () => false, probe: yes }).scope, false, 'no systemd-run: plain children');
assert.equal(scopePlan({ env: svc, uid: 1000, exists: yes, probe: yes }).scope, false, 'not root: plain children');
assert.equal(scopePlan({ env: {}, uid: 0, exists: yes, probe: yes }).scope, false, 'not started by systemd: plain children');
assert.equal(scopePlan({ env: svc, uid: 0, exists: yes, probe: () => false }).scope, false, 'a scope that cannot be made: plain children');
const on = scopePlan({ env: svc, uid: 0, exists: yes, probe: yes });
assert.deepEqual(on, { scope: true, bin: '/usr/bin/systemd-run', slice: 'seqln-hosted.slice' }, 'a root systemd service: scopes in seqln-hosted.slice');
assert.equal(scopePlan({ env: { LSP_NODE_SCOPE: '1', LSP_NODE_SLICE: 'x.slice' }, uid: 1000, exists: yes, probe: yes }).slice, 'x.slice', 'LSP_NODE_SCOPE=1 and LSP_NODE_SLICE');
assert.deepEqual(hostedCommand({ scope: false }, '/ld', ['--a']), { cmd: '/ld', args: ['--a'] }, 'no scope: the command itself');
assert.deepEqual(hostedCommand(on, '/ld', ['--a', '--b'], 'node X'),
  { cmd: '/usr/bin/systemd-run', args: ['--scope', '--quiet', '--collect', '--slice=seqln-hosted.slice', '--description=node X', '--', '/ld', '--a', '--b'] },
  'a scope: systemd-run --scope in the slice, then the command and its arguments unchanged');
console.log('part 1: the scope choice and its command: ok');

// --- Part 2: a real restart under a user systemd manager ----------------------------------------
const userManager = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0
  && fs.existsSync('/usr/bin/systemd-run');
if (!userManager) {
  console.log('part 2: SKIP (no user systemd manager here)');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-scope-'));
const tag = `hostedscope${process.pid}`;
const slice = `${tag}.slice`;
const sh = (name, body) => { const f = path.join(work, name); fs.writeFileSync(f, '#!/bin/bash\n' + body); fs.chmodSync(f, 0o755); return f; };
// systemd-run against the user's manager, standing in for the system one the LSP uses as root.
const runUser = sh('systemd-run-user', 'exec systemd-run --user "$@"\n');
// A lightningd: notes its pid where the stand-in lightning-cli reads it, then waits.
const ld = sh('lightningd', `dir=""; for a in "$@"; do case "$a" in --lightning-dir=*) dir="\${a#--lightning-dir=}";; esac; done
echo $$ > "$dir/standin.pid"; while :; do sleep 60; done\n`);
// lightning-cli getinfo: answers while that pid lives.
const cli = sh('lightning-cli', `rpc=""; for a in "$@"; do case "$a" in --rpc-file=*) rpc="\${a#--rpc-file=}";; esac; done
d=$(dirname "$(dirname "$rpc")"); p=$(cat "$d/standin.pid" 2>/dev/null) || exit 1
kill -0 "$p" 2>/dev/null || exit 1; echo '{"id":"02'"$(printf '%064d' "$p")"'"}'\n`);
const relay = sh('relay.sh', 'while :; do sleep 60; done\n');
// The stand-in LSP: provisions three nodes on its first start; on every start re-attaches the way
// lsp-server.mjs does (refresh each registry record) and writes what it found.
const standin = path.join(work, 'standin.mjs');
fs.writeFileSync(standin, `
import fs from 'node:fs';
import { makeProvisioner } from ${JSON.stringify(path.join(here, 'provision.mjs'))};
const scope = process.env.SCOPE === '1';
const P = makeProvisioner({ dir: process.env.PROV_DIR, lightningd: ${JSON.stringify(ld)}, node: '/bin/bash', wsRelay: ${JSON.stringify(relay)},
  hsmdProxy: 'x', lncli: ${JSON.stringify(cli)}, elementsCli: '/bin/true', rpcPort: 1, rpcUser: 'u', rpcPass: 'p',
  addrBase: 40000 + (process.pid % 2000) * 3, signerBase: 46000 + (process.pid % 2000) * 3, wsBase: 52000 + (process.pid % 2000) * 3,
  scopePlan: scope ? { scope: true, bin: ${JSON.stringify(runUser)}, slice: ${JSON.stringify(slice)} } : { scope: false, why: 'control' } });
let up = 0, seen = 0;
for (const rec of P.list()) { seen++; const r = await P.refresh(rec.key); if (r && r.status === 'running') up++; }
const start = Number(fs.existsSync(process.env.PROV_DIR + '/starts') ? fs.readFileSync(process.env.PROV_DIR + '/starts', 'utf8') : 0) + 1;
fs.writeFileSync(process.env.PROV_DIR + '/starts', String(start));
fs.writeFileSync(process.env.PROV_DIR + '/attach-' + start + '.json', JSON.stringify({ up, seen }));
if (start === 1) for (const k of ['11', '22', '33']) await P.provision({ assetId: k.repeat(32), deviceTransportPubkey: '02' + k.repeat(32), label: 'T' + k });
setInterval(() => {}, 1 << 30);
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pids of stand-in processes of one provisioner directory, by kind, from /proc.
function ours(provDir) {
  const out = { ld: [], relay: [] };
  for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' '); } catch { continue; }
    if (cmd.includes(ld) && cmd.includes(provDir)) out.ld.push(Number(p));
    else if (cmd.includes(relay) && cmd.includes('--ws-port')) {
      // A relay carries no directory: it is ours when its ws port is one this registry gave out.
      const reg = JSON.parse(fs.readFileSync(path.join(provDir, 'registry.json'), 'utf8'));
      const port = cmd.split(' ')[cmd.split(' ').indexOf('--ws-port') + 1];
      if (Object.values(reg.nodes).some((n) => String(n.wsPort) === port)) out.relay.push(Number(p));
    }
  }
  out.ld.sort(); out.relay.sort();
  return out;
}
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 250) { const v = fn(); if (v) return v; await sleep(250); }
  throw new Error('timed out waiting for ' + what);
}

async function trial(scope) {
  const provDir = path.join(work, scope ? 'prov-scope' : 'prov-control');
  fs.mkdirSync(provDir);
  const unit = `${tag}-${scope ? 'scope' : 'control'}.service`;
  execFileSync('systemd-run', ['--user', '--quiet', `--unit=${unit}`, '-p', 'KillMode=control-group',
    `--setenv=PROV_DIR=${provDir}`, `--setenv=SCOPE=${scope ? 1 : 0}`, process.execPath, standin]);
  try {
    const before = await waitFor(() => { const o = ours(provDir); return o.ld.length === 3 && o.relay.length === 3 ? o : null; }, 20000, 'three nodes and relays');
    execFileSync('systemctl', ['--user', 'restart', unit]);
    const attach = await waitFor(() => fs.existsSync(path.join(provDir, 'attach-2.json')) && JSON.parse(fs.readFileSync(path.join(provDir, 'attach-2.json'), 'utf8')), 20000, 'the second start');
    await sleep(500);
    return { before, after: ours(provDir), attach };
  } finally {
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
    for (const p of [...ours(provDir).ld, ...ours(provDir).relay]) { try { process.kill(p, 'SIGKILL'); } catch {} }
  }
}

try {
  const s = await trial(true);
  console.log(`part 2, scopes: before ${s.before.ld.length} nodes ${s.before.ld.join(',')}, ${s.before.relay.length} relays; after the restart ${s.after.ld.length} nodes ${s.after.ld.join(',')}, ${s.after.relay.length} relays; the new start re-attached ${s.attach.up}/${s.attach.seen}`);
  assert.deepEqual(s.after, s.before, 'the same node and relay processes run after the LSP restart');
  assert.deepEqual(s.attach, { up: 3, seen: 3 }, 'the restarted LSP re-attaches every hosted node');
  const c = await trial(false);
  console.log(`part 2, control (no scopes): before ${c.before.ld.length} nodes, ${c.before.relay.length} relays; after the restart ${c.after.ld.length} nodes, ${c.after.relay.length} relays; re-attached ${c.attach.up}/${c.attach.seen}`);
  assert.equal(c.after.ld.length + c.after.relay.length, 0, 'control: without scopes the restart stops every node and relay');
  assert.deepEqual(c.attach, { up: 0, seen: 3 }, 'control: nothing to re-attach');
  console.log('part 2: hosted nodes outlive an LSP restart only in scopes of their own: ok');
} finally {
  spawnSync('systemctl', ['--user', 'stop', slice], { stdio: 'ignore' });
  fs.rmSync(work, { recursive: true, force: true });
}
