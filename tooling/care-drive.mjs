#!/usr/bin/env node
// Drives what the wallet does by itself with leaves, in a headless Chromium, against a
// local regtest operator, with the page in user mode throughout except where developer
// mode is the thing checked:
//
//  1. a distribution to three holders, one of them this page's wallet named by the key
//     of the address its Receive tab shows: the page takes its claim up with no click,
//     and the asset appears in its one figure on the Balance tab;
//  2. the claimed leaf, a leaf of no round, refreshed into a round by itself once near its
//     window, and the round's new leaf, once its refresh could run within ten days,
//     planned by itself (developer mode lists the plan, with Cancel and Release);
//  3. the browser closed across that leaf's expiry: the operator runs the plan's step,
//     the old batch expires, and the page, opened again, holds the value live, the same
//     one figure as before it closed;
//  4. the user-mode screens free of the developer words.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and that
// repository's command-line wallet built (`arca`), which plays the payer and the two
// other holders.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     node tooling/care-drive.mjs <evidence-dir>
//
// Needs pkg/ (the lwk_wasm build) and leaves/pkg with the library's `care`, and a
// Chromium (CHROMIUM=…).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { HDKey, mnemonicToSeedSync } from '../btc.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
const out = resolve(process.argv[2] || join(tmpdir(), 'care-drive-evidence'))
if (!cliBin) { console.error('ARCA_CLI must name the command-line wallet binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }
const DAY = 86_400

// The words user mode never shows (the Balance, Send and Receive tabs and the header).
export const DEVELOPER_WORDS = ['leaf', 'leaves', 'round', 'plan', 'claim', 'distribution', 'expiry', 'operator', 'forfeit',
  'covenant', 'anchor', 'atoms', 'unroll', 'refresh', 'csv']

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}

const work = mkdtempSync(join(tmpdir(), 'care-drive-'))
const wallets = {}
const cli = (name, ...args) => {
  wallets[name] = wallets[name] || join(work, 'cli-' + name)
  let text
  try { text = execFileSync(cliBin, ['--datadir', wallets[name], '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}

let failures = 0
let step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}

const profile = join(work, 'profile')
let page = new Page(undefined, { profile })
const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })

async function shot (name) {
  step++
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`)
  await page.screenshot(f)
  note(`     screenshot ${f.split('/').pop()}`)
}
const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`)
const click = async (sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`) }
const set = (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
const idle = () => page.waitFor("!document.querySelector('.leaf-busy')", 120000)
const setMode = async (m) => {
  await click('[data-tab=settings]')
  await page.eval(`(()=>{const c=document.querySelector('#mode${m === 'developer' ? 'Developer' : 'User'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await page.waitFor(`document.querySelector('#tabLeaves').classList.contains('hide') === ${m !== 'developer'}`, 10000)
}
// The asset's one figure on the Balance tab, and what its row shows.
const balanceRow = (ticker) => page.eval(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(ticker)}); return r ? { total: r.querySelector('.bt-t').innerText.replace(/\\s+/g,' ').trim(), text: r.innerText.replace(/\\s+/g,' ').trim(), split: (r.querySelector('.bt-split, .leaf-split')||{}).innerText||'' } : null })()`)
const userScreensText = async () => {
  const parts = []
  for (const t of ['balance', 'send', 'receive']) { await click(`[data-tab=${t}]`); await new Promise((r) => setTimeout(r, 400)); parts.push(await page.eval("(document.querySelector('section:not(.hide)[data-panel]')||document.body).innerText")) }
  parts.push(await page.eval("(document.querySelector('header')||{}).innerText||''"))
  await click('[data-tab=balance]')
  return parts.join('\n')
}
// The Balance and History tabs' Refresh buttons reload the page's view: an ordinary verb there,
// not the leaf refresh the word list is about, so their labels are left out of the check.
const devWordsIn = (t) => DEVELOPER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t.replace(/^Refresh$/gm, '')))

async function openPage (base, fresh) {
  await page.open()
  // Nothing of the public testnet is reached from this drive: its host is blocked, and the page's
  // own config block (which names the testnet's Lightning service) is held to no Lightning at all.
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=3000; window.SEQ_LEAVES_CARE_MS=5000;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await page.go(base)
  if (fresh) {
    await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
    await click('#btnCreate')
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await click('#btnConfirm')
  }
  // A wallet still held by a tab of a browser that is closing: wait, and load again.
  for (let i = 0; i < 6; i++) {
    try { await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 15000); return } catch {}
    note('     the wallet is still held by a closing tab: loading again')
    await page.go(base)
  }
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 30000)
}

async function main () {
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  const st = await ctl('/state')
  const X = st.x
  note(`page ${base}; operator ${st.server}; node ${st.node_url}; asset X ${X}`)
  const create = ['create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca']

  // --- The page's wallet: created, joined in developer mode, then back to user mode ---
  await openPage(base, true)
  await page.eval(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: 'XCARE', name: 'Drive asset', precision: 0, local: true } }))`)
  const mnemonic = await page.eval("localStorage.getItem('swk.sequentia.mnemonic')")
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafJoin')", 30000)
  await set('leafServer', base + 'operator'); await set('leafNodeUrl', base + 'node')
  await set('leafNodeUser', st.node_user); await set('leafNodePassword', st.node_password)
  await set('leafDelay', '1'); await set('leafMinDelay', '1')
  await click('#btnLeafJoin')
  await page.waitFor("document.querySelector('#leafRails')", 120000)
  check('the page wallet joined the operator (developer mode)', true)
  await setMode('user')
  await click('[data-tab=balance]')

  // The key of the address the Receive tab shows: m/84'/1'/0'/0/i, i the page's index.
  const index = await page.eval('(()=>{ try { return addrIndex ?? 0 } catch { return 0 } })()').catch(() => 0)
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic))
  const pageKey = Buffer.from(root.derive(`m/84'/1'/0'/0/${Number(index) || 0}`).publicKey).toString('hex')
  note(`     the page's receive key at index ${index}: ${pageKey}`)

  // --- The payer, and two other holders (command-line wallets) ---
  cli('payer', ...create)
  await ctl('/fund', { script: cli('payer', 'address').script_pubkey, asset: X, amount: 30000000 })
  await ctl('/produce')
  cli('payer', 'board', X, '22000000')
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && cli('payer', 'boards')[0]?.server?.state !== 'credited'; i++) await new Promise((r) => setTimeout(r, 500))
  cli('payer', 'sync')
  const holders = [['page', pageKey, 3000000]]
  for (const h of ['holder-b', 'holder-c']) { cli(h, ...create); holders.push([h, cli(h, 'address').key, 2000000]) }
  const file = join(work, 'claims.txt')
  writeFileSync(file, '# key amount\n' + holders.map(([, k, v]) => `${k} ${v}`).join('\n') + '\n')
  const q = cli('payer', 'distribute', file, '--asset', X, '--quote')
  const d = cli('payer', 'distribute', file, '--asset', X, '--shown', String(q.fee))
  check('the payer distributes to three holders, the page wallet one of them', d.state === 'pending' && (d.claims || []).length === 3, { fee: q.fee, state: d.state, error: d.error })
  const r1 = await ctl('/round')
  note(`     the distribution's round ${JSON.stringify(r1)}`)
  cli('payer', 'sync')

  // --- 1. Taken up with no click: the asset appears in its one figure ---
  await page.waitFor(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='XCARE'); return !!r })()`, 180000)
  const row = await balanceRow('XCARE')
  check('user mode: the claim taken up with no click shows in XCARE\'s one figure', !!row && /\b\d/.test(row.total), row)
  await shot('claim-taken-up-user-mode')
  for (const h of ['holder-b', 'holder-c']) {
    const t = cli(h, 'care')
    check(`${h} takes its claim up by care`, (t.claims || []).some((c) => c.taken_up), (t.claims || []).map((c) => c.taken_up ? 'taken up' : (c.state || c.error)))
  }
  const words1 = devWordsIn(await userScreensText())
  check('user mode: Balance, Send, Receive and the header carry no developer word', words1.length === 0, words1)
  await page.eval("(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='XCARE'); if(r) r.click(); return true })()")
  const tapped = await balanceRow('XCARE')
  note(`     the row tapped: ${JSON.stringify(tapped)}`)
  await shot('balance-user-mode-tapped')
  const figureBefore = row.total

  // --- 2. Planned by itself once the leaf's refresh could run within ten days ---
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafCare')", 30000)
  const care0 = await page.eval("({ ...document.querySelector('#leafCare').dataset })")
  note(`     care so far: ${JSON.stringify(care0)}`)
  const coins = await page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>({...d.dataset}))")
  const live = coins.filter((c) => c.state === 'live')
  check('the claimed value is held as a live leaf', live.length >= 1, live.map((c) => [c.leaf, c.value, c.exitBy]))
  const expiry = Math.max(...live.map((c) => Number(c.exitBy || 0) + 3 * DAY))
  const now0 = Number(await page.eval("document.querySelector('#leafSync').dataset.now"))
  // Ten days before its step window (five days before expiry) opens, and a day more. The claim
  // is a leaf of no round: care first refreshes it into a round, whose new leaf is then planned
  // once it, too, is that near its window.
  await ctl('/advance', { seconds: Math.max(0, expiry - 5 * DAY - 10 * DAY + DAY - now0) })
  await page.waitFor("Number((document.querySelector('#leafCare')||{dataset:{}}).dataset.refreshing||0) >= 1", 180000)
  check('care refreshed the claimed leaf into a round by itself', true)
  const rr = await ctl('/round')
  note(`     its round ${JSON.stringify(rr)}`)
  await page.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live' && Number(d.dataset.exitBy) > ${expiry - 3 * DAY})`, 180000)
  const fresh = await page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].filter(d=>d.dataset.state==='live').map(d=>({...d.dataset}))")
  const expiry2 = Math.max(...fresh.map((c) => Number(c.exitBy || 0) + 3 * DAY))
  check('the new leaf of the round is live, a horizon later', expiry2 > expiry, fresh.map((c) => [c.leaf, c.value, c.exitBy]))
  const t0 = (await ctl('/advance', { seconds: 1 })).median_time
  await ctl('/advance', { seconds: Math.max(1, expiry2 - 5 * DAY - 10 * DAY + DAY - t0) })
  await page.waitFor("document.querySelectorAll('#leafPlans .leaf-plan[data-state=open]').length >= 1", 180000)
  const plans = await page.eval("[...document.querySelectorAll('#leafPlans .leaf-plan')].map(p=>({ plan: p.dataset.plan, state: p.dataset.state, text: p.innerText.replace(/\\s+/g,' ') }))")
  check('developer mode: the leaf planned by itself, with Cancel and Release', plans.length >= 1 && /Cancel/.test(plans[0].text) && /Release/.test(plans[0].text), plans)
  await shot('plan-developer-mode')
  await setMode('user')
  await click('[data-tab=balance]')
  const words2 = devWordsIn(await userScreensText())
  check('user mode after planning: still no developer word', words2.length === 0, words2)

  // --- 3. Closed across the expiry ---
  await page.stop()
  // The browser is gone once its profile lock is: a new one on the same profile would
  // otherwise join the old process, whose tab still holds the wallet.
  for (let i = 0; i < 60 && existsSync(join(profile, 'SingletonLock')); i++) await new Promise((r) => setTimeout(r, 500))
  note('     the browser is closed')
  // The step window opens five days before the expiry: the operator runs the step in a
  // round of its own, then completes it.
  const t1 = (await ctl('/advance', { seconds: 1 })).median_time
  await ctl('/advance', { seconds: Math.max(1, expiry2 - 5 * DAY + 3600 - t1) })
  let stepRound = null
  for (let i = 0; i < 10 && !stepRound; i++) { stepRound = (await ctl('/round')).round; if (!stepRound) await ctl('/bury') }
  await ctl('/pass')
  check('the operator ran the plan\'s step in a round while the browser was closed', !!stepRound, stepRound)
  // Past the expiry: the old batch is the operator's to release and sweep.
  const t2 = (await ctl('/advance', { seconds: 6 * DAY })).median_time
  for (let i = 0; i < 4; i++) { await ctl('/produce'); await ctl('/bury'); await ctl('/pass') }
  check('the chain\'s median time is past the leaf\'s expiry', t2 > expiry2, { now: t2, expiry: expiry2 })

  page = new Page(undefined, { profile })
  await openPage(base, false)
  await click('[data-tab=balance]')
  await page.waitFor(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='XCARE'); return r && r.querySelector('.bt-t').innerText.replace(/\\s+/g,' ').trim()===${JSON.stringify(figureBefore)} })()`, 240000).catch(() => {})
  const after = await balanceRow('XCARE')
  check('opened after the expiry: the same one figure, its value live', !!after && after.total === figureBefore, { before: figureBefore, after })
  await shot('after-expiry-user-mode')
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafCoins')", 30000)
  // The page syncs by itself (the coin is past its home date, so the schedule is due): the
  // plan's step is taken up, the old coin spent.
  await page.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live' && Number(d.dataset.exitBy) + ${3 * DAY} > ` + expiry2 + `)`, 180000).catch(() => {})
  const coins2 = await page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>({...d.dataset}))")
  check('developer mode: the value live in the step\'s new leaf', coins2.some((c) => c.state === 'live' && Number(c.exitBy) + 3 * DAY > expiry2), coins2.map((c) => [c.leaf, c.state, c.value, c.exitBy]))
  note('     leaves after the expiry: ' + (await text('#leafCoins')).replace(/\n+/g, ' | ').slice(0, 1500))
  note('     last sync: ' + (await page.eval("(()=>{ const p=document.querySelector('#leafSync details pre'); return p ? p.textContent.replace(/\\s+/g,' ').slice(0, 3000) : '' })()")))
  await shot('after-expiry-developer-mode')
  check('no page error', page.errors.length === 0, page.errors)
}

try { await main() } catch (e) { failures++; note('FAIL ' + e.message); try { await shot('failure') } catch {} } finally {
  try { writeFileSync(join(out, 'console.log'), page.console.join('\n')) } catch {}
  try { await page.stop() } catch {}
  srv.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
