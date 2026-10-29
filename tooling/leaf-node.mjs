// The leaf wallet library (leaves/pkg, the same wasm the page's leaves/worker.js runs) in
// Node, for the programs in tooling/ that hold leaves outside a browser: the live leaf maker
// (leaf-maker.mjs) and the user-mode drill (user-mode-drill.mjs).
//
// The library expects a browser worker: it blocks on synchronous XMLHttpRequests and keeps
// its SQLite store on the origin private file system (OPFS) through synchronous access
// handles. This module gives it both, and nothing else:
//
//   • a synchronous XMLHttpRequest whose request runs on a helper thread (worker_threads),
//     the calling thread waiting on a shared buffer (Atomics.wait) until the answer is in;
//   • navigator.storage.getDirectory() over a directory on disk, whose files' synchronous
//     access handles read and write the file in place, so every write the library commits
//     is on disk before its next statement, as on OPFS.
//
// No amount, script or decision is computed here: the library answers, and this module
// passes its JSON through. One process holds one store directory.
//
//   import { leafLibrary } from './leaf-node.mjs'
//   const lib = await leafLibrary('/path/to/store-dir')
//   const w = lib.create(mnemonic, { server, node_url, node_user, node_password })
//   w.run('balance')   // -> the library's { result, start }
import { Worker } from 'node:worker_threads'
import { openSync, closeSync, readSync, writeSync, fstatSync, ftruncateSync, fsyncSync, mkdirSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Synchronous HTTP on a helper thread
// ---------------------------------------------------------------------------

const MAX_BODY = 64 * 1024 * 1024
const HELPER = `
const { parentPort, workerData } = require('node:worker_threads')
const ctl = new Int32Array(workerData.ctl)
const data = new Uint8Array(workerData.data)
parentPort.on('message', async (req) => {
  let status = 0, body = new Uint8Array(0)
  try {
    const ac = new AbortController()
    const t = req.timeout > 0 ? setTimeout(() => ac.abort(), req.timeout) : null
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body == null ? undefined : req.body, signal: ac.signal })
    body = new Uint8Array(await r.arrayBuffer())
    status = r.status
    if (t) clearTimeout(t)
  } catch (e) { status = 0; body = new TextEncoder().encode(String(e && e.message || e)) }
  if (body.length > data.length) { status = 0; body = new TextEncoder().encode('answer too large') }
  data.set(body)
  ctl[1] = status; ctl[2] = body.length
  Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0)
})
`
let helper = null
let ctl = null
let data = null
function httpSync (req) {
  if (!helper) {
    const ctlBuf = new SharedArrayBuffer(16), dataBuf = new SharedArrayBuffer(MAX_BODY)
    ctl = new Int32Array(ctlBuf); data = new Uint8Array(dataBuf)
    helper = new Worker(HELPER, { eval: true, workerData: { ctl: ctlBuf, data: dataBuf } })
    helper.unref()
  }
  Atomics.store(ctl, 0, 0)
  helper.postMessage(req)
  // A request the helper never answers (it cannot hang: fetch is aborted at the timeout) would
  // block here; the library sets a timeout on every request it makes.
  while (Atomics.wait(ctl, 0, 0, 600000) === 'timed-out') {}
  const status = ctl[1], len = ctl[2]
  return { status, text: new TextDecoder().decode(data.slice(0, len)) }
}

class SyncXMLHttpRequest {
  constructor () { this.headers = {}; this.status = 0; this.responseText = ''; this.timeout = 0 }
  open (method, url, async) {
    if (async !== false && async !== undefined && async !== 0) throw new Error('this XMLHttpRequest is synchronous only')
    this.method = method; this.url = url
  }
  setRequestHeader (k, v) { this.headers[k] = v }
  send (body) {
    const r = httpSync({ method: this.method, url: this.url, headers: this.headers, body: body == null ? null : String(body), timeout: this.timeout || 0 })
    if (r.status === 0) { const e = new Error(r.text || 'network error'); e.name = 'NetworkError'; throw e }
    this.status = r.status; this.responseText = r.text
  }
}

// ---------------------------------------------------------------------------
// OPFS over a directory
// ---------------------------------------------------------------------------

class SyncAccessHandle {
  constructor (path) { this.fd = openSync(path, 'r+') }
  read (buf, opts) {
    const at = (opts && opts.at) || 0
    const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength)
    let done = 0
    while (done < view.length) {
      const n = readSync(this.fd, view, done, view.length - done, at + done)
      if (n <= 0) break
      done += n
    }
    return done
  }
  write (buf, opts) {
    const at = (opts && opts.at) || 0
    const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength)
    let done = 0
    while (done < view.length) done += writeSync(this.fd, view, done, view.length - done, at + done)
    return done
  }
  getSize () { return fstatSync(this.fd).size }
  truncate (n) { ftruncateSync(this.fd, Number(n)) }
  flush () { fsyncSync(this.fd) }
  close () { if (this.fd != null) { closeSync(this.fd); this.fd = null } }
}

class FileHandle {
  constructor (path, name) { this.path = path; this.name = name; this.kind = 'file' }
  async createSyncAccessHandle () { return new SyncAccessHandle(this.path) }
  async getFile () { const b = readFileSync(this.path); return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } }
}

function notFound (name) { const e = new Error(`${name} not found`); e.name = 'NotFoundError'; return e }

class DirectoryHandle {
  constructor (path, name) { this.path = path; this.name = name; this.kind = 'directory' }
  async getDirectoryHandle (name, opts) {
    const p = join(this.path, name)
    try { if (statSync(p).isDirectory()) return new DirectoryHandle(p, name) } catch {}
    if (!(opts && opts.create)) throw notFound(name)
    mkdirSync(p, { recursive: true })
    return new DirectoryHandle(p, name)
  }
  async getFileHandle (name, opts) {
    const p = join(this.path, name)
    try { if (statSync(p).isFile()) return new FileHandle(p, name) } catch {}
    if (!(opts && opts.create)) throw notFound(name)
    closeSync(openSync(p, 'a'))
    return new FileHandle(p, name)
  }
  async removeEntry (name, opts) {
    const p = join(this.path, name)
    try { statSync(p) } catch { throw notFound(name) }
    rmSync(p, { recursive: !!(opts && opts.recursive) })
  }
  async * entries () {
    for (const n of readdirSync(this.path)) {
      const p = join(this.path, n)
      yield [n, statSync(p).isDirectory() ? new DirectoryHandle(p, n) : new FileHandle(p, n)]
    }
  }
  async * keys () { for await (const [n] of this.entries()) yield n }
  async * values () { for await (const [, h] of this.entries()) yield h }
  [Symbol.asyncIterator] () { return this.entries() }
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

let loaded = null

// Loads the library once per process, its store in `storeRoot` (a directory of this
// program's own). Answers { exists, create, open }, each wallet { run, close }. LEAVES_PKG names
// another build of the library than the page's leaves/pkg.
export async function leafLibrary (storeRoot, { pkgDir = process.env.LEAVES_PKG || join(here, '..', 'leaves', 'pkg') } = {}) {
  if (loaded) {
    if (loaded.root !== storeRoot) throw new Error(`the leaf library already runs on ${loaded.root} in this process`)
    return loaded.api
  }
  mkdirSync(storeRoot, { recursive: true })
  const root = new DirectoryHandle(storeRoot, '')
  globalThis.XMLHttpRequest = SyncXMLHttpRequest
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis
  // The library's storage checks it runs in a worker; this thread blocks like one.
  if (typeof globalThis.WorkerGlobalScope === 'undefined') globalThis.WorkerGlobalScope = Object
  const storage = { getDirectory: async () => root }
  try { Object.defineProperty(globalThis.navigator, 'storage', { value: storage, configurable: true }) }
  catch { globalThis.navigator = { storage } }
  const mod = await import(join(pkgDir, 'leaf_wallet.js'))
  await mod.default({ module_or_path: readFileSync(join(pkgDir, 'leaf_wallet_bg.wasm')) })
  await mod.installStore('.leaf-wallet')
  const parse = (s) => JSON.parse(s)
  const call = (f) => {
    try { return f() } catch (e) {
      // A refusal is the library's own JSON, { error: { kind, message, code?, status? } }.
      if (typeof e === 'string') { let j = null; try { j = JSON.parse(e) } catch {} ; if (j && j.error) { const x = new Error(j.error.message); Object.assign(x, j.error); throw x } }
      throw e
    }
  }
  // The node scans one wallet at a time: a command that meets another wallet's scan is asked
  // again after a pause (the library's own words; nothing else is retried).
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const retried = (f) => {
    for (let i = 0; ; i++) {
      try { return call(f) } catch (e) {
        if (i < 10 && /Scan already in progress/.test(String(e && e.message))) { pause(300 + 300 * i); continue }
        throw e
      }
    }
  }
  const wrap = (w) => ({
    run: (command, args = {}) => retried(() => parse(w.run(String(command), JSON.stringify(args)))),
    // The command's answer alone, as the page's leaves.command answers it.
    command: (command, args = {}) => retried(() => parse(w.run(String(command), JSON.stringify(args)))).result,
    close: () => { try { w.free() } catch {} },
  })
  const api = {
    exists: (mnemonic) => call(() => mod.arcaWalletExists(mnemonic)),
    create: (mnemonic, config) => wrap(call(() => mod.ArcaWallet.create(mnemonic, JSON.stringify(config || {})))),
    open: (mnemonic, nodePassword) => wrap(call(() => mod.ArcaWallet.open(mnemonic, nodePassword || undefined))),
  }
  loaded = { root: storeRoot, api }
  return api
}

// Which queued job the thread runs next, at `now`: the first that is `first`, else the oldest,
// unless the queue is held (`holdUntil`), when only a `first` job runs. -> an index, or -1 to wait.
export function nextJob (queue, now, holdUntil = 0) {
  const i = queue.findIndex((q) => q.first)
  if (i >= 0) return i
  if (!queue.length || now < holdUntil) return -1
  return 0
}

// The same library on a thread of its own, so a program that serves requests (the leaf maker)
// keeps answering while a long command (a sync behind the node's scan lock) runs. Commands run
// one at a time, in order of priority, then of arrival: `command(name, args, { first: true })`
// goes ahead of every queued command that is not first. `hold(ms)` keeps every command that is
// not first queued for that long, so one a person is about to ask for (a firm offer after a
// quote) finds the library free rather than behind the program's own upkeep; a command already
// running still ends first. `onSlow(name, ms)` is told of each command that took over five
// seconds.
//   const lib = await leafLibraryThread(storeRoot)
//   const w = await lib.open(mnemonic, nodePassword)   // or create(mnemonic, config)
//   await w.command('sync')
export async function leafLibraryThread (storeRoot, { onSlow = null } = {}) {
  const { Worker: W } = await import('node:worker_threads')
  const worker = new W(new URL(import.meta.url), { workerData: { leafThread: storeRoot } })
  const queue = []
  const waiting = new Map()
  let next = 1, busy = false, holdUntil = 0, timer = null
  worker.on('message', (m) => {
    const p = waiting.get(m.id); waiting.delete(m.id); busy = false
    if (p && onSlow && Date.now() - p.started > 5000) { try { onSlow((p.args && p.args.name) || p.op, Date.now() - p.started) } catch {} }
    if (p) { if (m.ok) p.ok(m.value); else { const e = new Error(m.error.message); Object.assign(e, m.error); p.no(e) } }
    pump()
  })
  worker.on('error', (e) => { for (const p of waiting.values()) p.no(e); waiting.clear() })
  function pump () {
    if (busy || !queue.length) return
    const i = nextJob(queue, Date.now(), holdUntil)
    if (i < 0) { if (!timer) timer = setTimeout(() => { timer = null; pump() }, Math.max(1, holdUntil - Date.now())); return }
    const job = queue.splice(i, 1)[0]
    job.started = Date.now()
    busy = true
    waiting.set(job.id, job)
    worker.postMessage({ id: job.id, op: job.op, args: job.args })
  }
  const call = (op, args, first = false) => new Promise((ok, no) => { queue.push({ id: next++, op, args, first, ok, no }); pump() })
  const wallet = { command: (name, args = {}, opts = {}) => call('command', { name, args }, !!opts.first) }
  return {
    hold: (ms) => { holdUntil = Math.max(holdUntil, Date.now() + ms) },
    exists: (mnemonic) => call('exists', { mnemonic }),
    open: async (mnemonic, nodePassword) => { await call('open', { mnemonic, nodePassword }); return wallet },
    create: async (mnemonic, config) => { await call('create', { mnemonic, config }); return wallet },
    stop: () => worker.terminate(),
  }
}

// The thread's side of leafLibraryThread.
{
  const wt = await import('node:worker_threads')
  if (!wt.isMainThread && wt.workerData && wt.workerData.leafThread) {
    const lib = await leafLibrary(wt.workerData.leafThread)
    let w = null
    wt.parentPort.on('message', ({ id, op, args }) => {
      try {
        let value
        if (op === 'exists') value = lib.exists(args.mnemonic)
        else if (op === 'open') { w = lib.open(args.mnemonic, args.nodePassword); value = true }
        else if (op === 'create') { w = lib.create(args.mnemonic, args.config); value = true }
        else if (op === 'command') value = w.command(args.name, args.args)
        wt.parentPort.postMessage({ id, ok: true, value })
      } catch (e) { wt.parentPort.postMessage({ id, ok: false, error: { message: e.message, kind: e.kind || null, code: e.code || null, status: e.status || null } }) }
    })
  }
}
