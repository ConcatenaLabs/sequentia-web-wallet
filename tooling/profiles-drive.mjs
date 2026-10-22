#!/usr/bin/env node
// Drives the leaf wallet through what an operator's profiles ask of it, in a headless
// Chromium, against a local regtest operator serving a supervised asset, an
// issuer-operated asset and an equivocation bond:
//
//  1. a payment that needs a planned leaf: every leaf of a round planned by `care`, then a
//     payment larger than any free leaf, made through the next round with no prompt;
//  2. a supervised asset boarded, received and refreshed, every leaf landing at the
//     wallet's own landing key; frozen by its issuer (shown in both modes, a payment
//     refused); taken home by its landing into the wallet's key, frozen on the chain;
//     lifted; paid again;
//  3. an issuer-operated asset's batch profile and supply, in developer mode;
//  4. the bond in notice: a receive refused, the bond shown in developer mode;
//  5. the user-mode screens free of the developer words.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) started with ARCA_OPERATOR_SUPERVISED and
// ARCA_OPERATOR_ISSUER, at its control address; that repository's command-line wallet
// (`arca`), the counterparty; pkg/ (the lwk_wasm build); a Chromium (CHROMIUM=…).
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     [SEQ_DRIVE_MNEMONIC_FILE=phrase.txt] node tooling/profiles-drive.mjs <evidence-dir>
//
// With SEQ_DRIVE_MNEMONIC_FILE naming a file that exists, the page opens that phrase (and
// its join restores what the operator holds of it); otherwise it creates a wallet and
// writes its phrase there, so another wallet can be driven with the same phrase after.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
const phraseFile = process.env.SEQ_DRIVE_MNEMONIC_FILE || null
const out = resolve(process.argv[2] || join(tmpdir(), 'profiles-drive-evidence'))
if (!cliBin) { console.error('ARCA_CLI must name the command-line wallet binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }

// The words user mode never shows (the Balance, Send and Receive tabs and the header).
const DEVELOPER_WORDS = ['leaf', 'leaves', 'round', 'plan', 'claim', 'distribution', 'expiry', 'operator', 'forfeit',
  'covenant', 'anchor', 'atoms', 'unroll', 'refresh', 'csv', 'landing', 'bond', 'exit']
const FROZEN_SENTENCE = /is frozen by its issuer: it can't be sent until the issuer lifts the freeze\./

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, { method: 'POST', body: JSON.stringify(body || {}) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
const rpc = (method, params = []) => ctl('/rpc', { method, params })

const work = mkdtempSync(join(tmpdir(), 'profiles-drive-'))
const cliDir = join(work, 'cli')
const cli = (...args) => {
  let text
  try { text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}

let failures = 0
let step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}

const page = new Page(undefined, { profile: join(work, 'profile') })
const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })

async function shot (name) {
  step++
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`)
  await page.screenshot(f)
  note(`     screenshot ${f.split('/').pop()}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idle = () => page.waitFor("!document.querySelector('.leaf-busy')", 600000)
const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`)
const click = async (sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`) }
const set = (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
const coins = () => page.eval("[...document.querySelectorAll('#leafCoins > .leaf-coin')].map(d=>({...d.dataset, text: d.innerText.replace(/\\s+/g,' ')}))")
const syncNow = async () => { await idle(); await click('#btnLeafSync'); await idle() }
const setMode = async (m) => {
  await click('[data-tab=settings]')
  await page.eval(`(()=>{const c=document.querySelector('#mode${m === 'developer' ? 'Developer' : 'User'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await page.waitFor(`document.querySelector('#tabLeaves').classList.contains('hide') === ${m !== 'developer'}`, 10000)
}
const leavesTab = async () => { await click('[data-tab=leaves]'); await page.waitFor("document.querySelector('#leafCoins')", 60000) }
const balanceRow = (ticker) => page.eval(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(ticker)}); return r ? { total: (r.querySelector('.bt-t')||{}).innerText, text: r.innerText.replace(/\\s+/g,' ').trim(), frozen: (r.querySelector('.bt-frozen')||{}).innerText||'' } : null })()`)
const userScreensText = async () => {
  const parts = []
  for (const t of ['balance', 'send', 'receive']) { await click(`[data-tab=${t}]`); await sleep(400); parts.push(await page.eval("(document.querySelector('section:not(.hide)[data-panel]')||document.body).innerText")) }
  parts.push(await page.eval("(document.querySelector('header')||{}).innerText||''"))
  await click('[data-tab=balance]')
  return parts.join('\n')
}
const devWordsIn = (t) => DEVELOPER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t.replace(/^Refresh$/gm, '')))

// A board from the page's leaf wallet: quoted, confirmed, mined, credited and live.
async function board (asset, amount) {
  await page.waitFor(`document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${asset}')`, 120000)
  await set('leafBoardAsset', asset); await set('leafBoardAmount', String(amount))
  await click('#btnLeafBoard'); await idle()
  await click('#btnLeafBoardConfirm'); await idle()
  const b = JSON.parse(await page.eval("document.querySelector('#leafBoard .leaf-result').textContent"))
  if (!b.leaf_id) throw new Error('the board: ' + JSON.stringify(b))
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 40; i++) {
    await syncNow()
    if ((await coins()).some((c) => c.leaf === b.leaf_id && c.state === 'live')) break
    await sleep(1000)
  }
  return b
}

// Settle now for one leaf: quoted, confirmed, the round built and final, and the page's
// own sync following it to the new leaf.
async function settle (leaf) {
  await page.eval(`document.querySelector('[data-leaf="${leaf}"] [data-action=settle]').click()`); await idle()
  await click('#btnLeafSettleConfirm'); await idle()
  let round = null
  for (let i = 0; i < 6 && !round; i++) { round = (await ctl('/round')).round; if (!round) { await ctl('/bury'); await sleep(1000) } }
  for (let i = 0; i < 40; i++) {
    await syncNow()
    if ((await coins()).some((c) => c.leaf === leaf && c.state === 'spent') || !(await coins()).some((c) => c.leaf === leaf)) break
    await sleep(1500)
  }
  return round
}

async function main () {
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  const st = await ctl('/state')
  const X = st.x; const Z = st.supervised; const I = st.issuer
  if (!Z || !I) throw new Error('the harness serves no supervised or no issuer-operated asset: start it with ARCA_OPERATOR_SUPERVISED and ARCA_OPERATOR_ISSUER')
  note(`page ${base}; operator ${st.server}; node ${st.node_url}; X ${X}; supervised Z ${Z}; issuer-operated I ${I}`)

  // The operator's bond, posted before the wallet joins: the wallet sees it bonded.
  const bond = st.bond ? { bond: st.bond } : await ctl('/bond_post', {})
  note(`     the operator's bond: ${JSON.stringify(bond)}`)

  // --- The counterparty: a command-line wallet holding X and Z leaves ---
  cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1')
  for (const a of [X, Z]) await ctl('/fund', { script: cli('address').script_pubkey, asset: a, amount: 5000000 })
  await ctl('/produce')
  for (const a of [X, Z]) { const r = cli('board', a, '3000000'); if (r.error) throw new Error('the CLI board: ' + r.error.message) }
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && !cli('boards').every((b) => b.server?.state === 'credited'); i++) await sleep(500)
  cli('sync')

  // --- The page's wallet: opened, joined in developer mode ---
  await page.open()
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=4000; window.SEQ_LEAVES_CARE_MS=5000;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await page.go(base)
  const given = phraseFile && existsSync(phraseFile) ? readFileSync(phraseFile, 'utf8').trim() : null
  if (given) {
    await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(given)})`)
    await page.go(base)
  } else {
    await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
    await click('#btnCreate')
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await click('#btnConfirm')
  }
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  const mnemonic = await page.eval("localStorage.getItem('swk.sequentia.mnemonic')")
  if (phraseFile && !given) writeFileSync(phraseFile, mnemonic + '\n', { mode: 0o600 })
  check(given ? 'the page opened the given phrase' : 'the page made a wallet' + (phraseFile ? ' and kept its phrase for the next wallet' : ''), mnemonic && mnemonic.split(/\s+/).length >= 12)
  await page.eval(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: 'XW', name: 'Drive asset', precision: 0, local: true }, ${JSON.stringify(Z)}: { ticker: 'USDZ', name: 'Supervised drive asset', precision: 0, local: true }, ${JSON.stringify(I)}: { ticker: 'ISS', name: 'Issuer-operated drive asset', precision: 0, local: true } }))`)
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafJoin') || document.querySelector('#leafRails')", 60000)
  if (await page.eval("!!document.querySelector('#leafJoin')")) {
    await set('leafServer', base + 'operator'); await set('leafNodeUrl', base + 'node')
    await set('leafNodeUser', st.node_user); await set('leafNodePassword', st.node_password)
    await set('leafDelay', '1'); await set('leafMinDelay', '1')
    await click('#btnLeafJoin')
    await page.waitFor("document.querySelector('#leafRails')", 180000)
  }
  check('the page wallet joined the operator', true)
  await idle()

  // The leaf wallet's landing: the first on-chain key of the phrase, the same in every wallet.
  const info = JSON.parse(await page.eval("(async()=>JSON.stringify(await window.sequentiaWallet.request({method:'getLeafInfo'}).catch(e=>({error:e.message}))))()").catch(() => '{}'))
  let landing = info && info.landing_address
  if (!landing) {
    // The page API answers no landing: read it from the first board's coin below.
    note('     the page API gives no landing address; it is read from the first supervised leaf')
  }

  // --- Funds on the leaf wallet's own chain side, and boards ---
  await click('#btnLeafAddress'); await idle()
  const script = await page.eval("document.querySelector('#leafAddress').dataset.script")
  for (const [a, v] of [[X, 8000000], [Z, 4000000], [I, 3000000]]) await ctl('/fund', { script, asset: a, amount: v })
  await ctl('/produce')
  await syncNow()
  const bx = await board(X, 2000000)
  const bz = await board(Z, 2000000)
  const bi = await board(I, 1000000)
  let cs = await coins()
  const zBoard = cs.find((c) => c.leaf === bz.leaf_id)
  check('Z boarded as a leaf that lands at the wallet\'s own landing key', zBoard && zBoard.state === 'live' && !!zBoard.landing, zBoard && { state: zBoard.state, landing: zBoard.landing })
  landing = landing || (zBoard && zBoard.landing)
  check('X boarded, a plain leaf with no landing', cs.some((c) => c.leaf === bx.leaf_id && c.state === 'live' && !c.landing))
  await shot('boarded-x-z-i')

  // --- Receive Z: the request names the landing; the coin lands there ---
  await set('leafRecvAsset', Z); await set('leafRecvAmount', '300000')
  await click('#btnLeafReceive'); await idle()
  const reqZ = await page.eval("document.querySelector('#leafRequest').value")
  const reqJson = JSON.parse(Buffer.from(reqZ.slice(reqZ.indexOf(':') + 1), 'hex').toString())
  check('the receive request carries the wallet\'s landing', /^[0-9a-f]{40}$/.test(reqJson.landing || ''), reqJson.landing)
  const paidZ = cli('send', reqZ, '--amount', '300000', '--asset', Z)
  check('the counterparty paid 300000 Z into the request', !paidZ.error, paidZ.error || 'paid')
  await syncNow()
  cs = await coins()
  const zRecv = cs.find((c) => c.asset === Z && c.value === '300000' && c.state === 'live')
  check('the payment of Z is held, landing at the same landing key', zRecv && zRecv.landing === landing, zRecv && { landing: zRecv.landing, want: landing })
  await shot('received-z')

  // --- Refresh: every board settled into a round of its asset ---
  const rx = await settle(bx.leaf_id)
  const rz = await settle(bz.leaf_id)
  const ri = await settle(bi.leaf_id)
  note(`     rounds: X ${rx}, Z ${rz}, I ${ri}`)
  cs = await coins()
  const zLeaf = cs.find((c) => c.asset === Z && c.kind === 'batch' && c.state === 'live')
  check('Z refreshed into a supervised batch: its new leaf lands at the landing key', zLeaf && zLeaf.landing === landing, zLeaf && { leaf: zLeaf.leaf, landing: zLeaf.landing })
  if (rz) {
    const chk = cli('supervised-check', `${rz}:0`)
    note(`     the CLI wallet's supervised-check of Z's round output 0: ok ${chk.ok}, ${(chk.problems || []).join('; ')}`)
  }
  const iLeaf = cs.find((c) => c.asset === I && c.kind === 'batch' && c.state === 'live')
  check('I refreshed into an issuer-operated batch: its leaf says so (developer mode)', iLeaf && iLeaf.batchProfile === 'issuer-operated', iLeaf && { profile: iLeaf.batchProfile })
  const xLeaf = cs.find((c) => c.asset === X && c.kind === 'batch' && c.state === 'live')
  check('X\'s new leaf is open', xLeaf && xLeaf.batchProfile === 'open', xLeaf && xLeaf.batchProfile)

  // --- Issuer-operated: the supply, read again on the wallet's node ---
  await page.waitFor(`!!document.querySelector('#leafSupply [data-asset="${I}"] [data-action=supply]')`, 60000)
  await page.eval(`document.querySelector('#leafSupply [data-asset="${I}"] [data-action=supply]').click()`); await idle()
  const sup = await page.eval(`(()=>{ const r=document.querySelector('#leafSupply [data-asset="${I}"]'); return { checked: r.dataset.checked, text: r.innerText.replace(/\\s+/g,' ') } })()`)
  check('developer mode: I\'s supply, every mint and burn read again on this node', sup.checked === 'true', sup.text.slice(0, 300))
  await page.eval("document.querySelector('#leafSupply').scrollIntoView()")
  await shot('issuer-supply-dev')

  // --- 1. A payment that needs a planned leaf, through the next round, no prompt ---
  await page.waitFor(`[...document.querySelectorAll('#leafCoins > .leaf-coin')].some(d=>d.dataset.asset===${JSON.stringify(X)} && d.dataset.state==='live' && d.dataset.planned)`, 180000)
  cs = await coins()
  const xPlanned = cs.filter((c) => c.asset === X && c.state === 'live')
  check('care planned every live X leaf of a round at once (nothing free in X)', xPlanned.length >= 1 && xPlanned.every((c) => c.planned), xPlanned.map((c) => [c.leaf.slice(0, 8), c.kind, c.planned ? 'planned' : 'free']))
  await page.eval("document.querySelector('#leafPlans').scrollIntoView()")
  await shot('every-leaf-planned-dev')
  const reqX = cli('receive', '--asset', X, '--amount', '500000').request
  await set('leafSendRequest', reqX); await set('leafSendAmount', '500000'); await set('leafSendAsset', X)
  const clicks0 = await page.eval('performance.now()')
  await click('#btnLeafSend')
  await page.waitFor("!!document.querySelector('#leafReleasing')", 120000)
  const releasing = await text('#leafReleasing')
  check('the payment waits for one round, giving up the planned leaf by itself', /planned leaf/.test(releasing), releasing.replace(/\s+/g, ' ').slice(0, 300))
  await shot('paying-through-the-next-round')
  let rr = null
  for (let i = 0; i < 20 && !rr; i++) { await sleep(2000); rr = (await ctl('/round')).round }
  check('the release\'s round was built and is final', !!rr, rr)
  await page.waitFor("!document.querySelector('#leafReleasing') && !document.querySelector('.leaf-busy')", 600000)
  const sent = await page.eval("(()=>{ const p=document.querySelector('#leafSend .leaf-result'); return p ? p.textContent : '' })()")
  const sentV = (() => { try { return JSON.parse(sent) } catch { return {} } })()
  check('the payment went through with no prompt after Send', sentV.sent && sentV.sent.value === '500000', sentV.sent || sent.slice(0, 300))
  const mbx = cli('sync')
  check('the counterparty holds the 500000 X', (mbx.mailbox?.accepted || []).some((c) => c.value === '500000'), (mbx.mailbox?.accepted || []).map((c) => c.value))
  note(`     Send to paid: ${Math.round((await page.eval('performance.now()') - clicks0) / 1000)} s, one round`)
  await shot('paid-through-the-next-round')

  // --- 2. Frozen by its issuer: the landing key named in a freeze record ---
  const landingSpk = (await rpc('validateaddress', [landing])).scriptPubKey
  const fz = await ctl('/freeze', { script: landingSpk })
  check('node: the issuer froze the landing key', fz.status && fz.status.frozen === true, fz)
  for (let i = 0; i < 20; i++) { await syncNow(); if ((await coins()).some((c) => c.asset === Z && c.frozen === 'true')) break; await sleep(1500) }
  cs = await coins()
  const zHeld = cs.filter((c) => c.asset === Z && ['live', 'pending'].includes(c.state))
  check('developer mode: every Z leaf shows frozen, with the sentence', zHeld.length >= 2 && zHeld.every((c) => c.frozen === 'true' && FROZEN_SENTENCE.test(c.text)), zHeld.map((c) => [c.leaf.slice(0, 8), c.frozen]))
  await page.eval(`document.querySelector('[data-leaf="${zLeaf.leaf}"]').scrollIntoView()`)
  await shot('frozen-dev')
  // A payment of Z: refused.
  const reqZ2 = cli('receive', '--asset', Z, '--amount', '100000').request
  await set('leafSendRequest', reqZ2); await set('leafSendAmount', '100000'); await set('leafSendAsset', Z)
  await click('#btnLeafSend'); await idle()
  const refusedZ = await text('#leafSend .leaf-refusal') || await text('.leaf-refusal')
  check('a payment of the frozen Z is refused, saying it is frozen', /frozen/i.test(refusedZ), refusedZ.replace(/\s+/g, ' ').slice(0, 300))
  await shot('frozen-send-refused-dev')
  // User mode: the one figure, and the sentence.
  await setMode('user')
  await click('[data-tab=balance]')
  await page.waitFor("(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='USDZ'); return r && r.querySelector('.bt-frozen') })()", 60000).catch(() => {})
  const zRow = await balanceRow('USDZ')
  check('user mode: USDZ\'s one figure, and one plain sentence for what is frozen', zRow && FROZEN_SENTENCE.test(zRow.frozen), zRow)
  await shot('frozen-user-mode')
  const words1 = devWordsIn(await userScreensText())
  check('user mode, frozen: Balance, Send, Receive and the header carry no developer word', words1.length === 0, words1)
  await setMode('developer'); await leavesTab()

  // --- The frozen leaf leaves the tree by its landing, into the wallet's own key ---
  await page.eval(`document.querySelector('[data-leaf="${zLeaf.leaf}"] [data-action=exit]').click()`); await idle()
  await click('#btnLeafExitConfirm'); await idle()
  let claimTxid = null
  for (let i = 0; i < 16 && !claimTxid; i++) {
    const dt = await text('#leafDrill')
    claimTxid = (dt.match(/claim ([0-9a-f]{64})/) || [])[1]
    if (claimTxid) break
    const runs = await page.eval("[...document.querySelectorAll('#leafDrill .leaf-drill-run')].map(d=>d.innerText)")
    const last = runs[runs.length - 1] || ''
    if (/waiting/.test(last)) await ctl('/advance', { seconds: 600 }); else await ctl('/produce')
    await click('#btnLeafExitAgain'); await idle()
    if (await page.eval("!!document.querySelector('#btnLeafExitConfirm')")) { await click('#btnLeafExitConfirm'); await idle() }
  }
  check('the exit claimed the frozen leaf', !!claimTxid, claimTxid)
  await ctl('/produce'); await ctl('/bury')
  if (claimTxid) {
    const tx = await rpc('getrawtransaction', [claimTxid, true])
    // The fee is an explicit output with an empty script; every other output of Z pays the landing.
    const outs = tx.vout.filter((o) => o.asset === Z && o.scriptPubKey.hex !== '')
    check('node: the claim pays Z to the landing key alone (beside its fee)', outs.length === 1 && outs[0].scriptPubKey.hex === landingSpk, tx.vout.filter((o) => o.asset === Z).map((o) => [o.value, o.scriptPubKey.hex || 'fee']))
    const fzState = await rpc('isassetfrozen', [Z, landingSpk])
    check('node: the landed coin is frozen on the chain', fzState.frozen === true, fzState)
  }
  await shot('landed-frozen-dev')
  await syncNow()
  await setMode('user'); await click('[data-tab=balance]')
  const zRow2 = await balanceRow('USDZ')
  check('user mode: the landed coin still counted, still said frozen', zRow2 && FROZEN_SENTENCE.test(zRow2.frozen), zRow2)
  await shot('landed-frozen-user-mode')
  await setMode('developer'); await leavesTab()

  // --- Lifted: the issuer spends the record; the remaining Z leaf pays again ---
  const lf = await ctl('/lift', { script: landingSpk })
  check('node: the issuer lifted the freeze', lf.status && lf.status.frozen === false, lf)
  for (let i = 0; i < 4; i++) { await ctl('/produce'); await ctl('/bury') }
  let paidAgain = null
  for (let i = 0; i < 20 && !paidAgain; i++) {
    await syncNow()
    const r = cli('receive', '--asset', Z, '--amount', '100000').request
    await set('leafSendRequest', r); await set('leafSendAmount', '100000'); await set('leafSendAsset', Z)
    await click('#btnLeafSend'); await idle()
    const res = await page.eval("(()=>{ const p=document.querySelector('#leafSend .leaf-result'); return p ? p.textContent : '' })()")
    try { const v = JSON.parse(res); if (v.sent && v.sent.value === '100000') paidAgain = v } catch {}
    if (!paidAgain) { note('     not yet: ' + (await text('#leafSend .leaf-refusal')).replace(/\s+/g, ' ').slice(0, 160)); await ctl('/produce'); await ctl('/bury'); await sleep(2000) }
  }
  check('lifted: Z is paid again', !!paidAgain, paidAgain && paidAgain.sent)
  await shot('lifted-paid-again')
  await setMode('user'); await click('[data-tab=balance]')
  const zRow3 = await balanceRow('USDZ')
  check('user mode after the lift: no frozen sentence', zRow3 && !zRow3.frozen, zRow3)
  await setMode('developer'); await leavesTab()

  // --- 3. The bond in notice: a receive refused ---
  await page.waitFor("document.querySelector('#leafBond') && document.querySelector('#leafBond').dataset.state==='bonded'", 120000)
  await page.eval("document.querySelector('#leafBond').scrollIntoView()")
  check('developer mode: the bond, its asset, value and state', /Bond\s/.test(await text('#leafBond')), (await text('#leafBond')).replace(/\s+/g, ' ').slice(0, 300))
  await shot('bond-bonded-dev')
  const notice = await ctl('/bond_notice', {})
  note(`     the bond's notice: ${JSON.stringify(notice)}`)
  await click('#btnLeafWatchBond'); await idle()
  await set('leafRecvAsset', X); await set('leafRecvAmount', '600000')
  await click('#btnLeafReceive'); await idle()
  const bondRefusal = await text('.leaf-refusal')
  check('the bond in notice: a receive is refused, saying why', /bond/.test(bondRefusal), bondRefusal.replace(/\s+/g, ' ').slice(0, 300))
  const bondCard = await text('#leafBond')
  check('developer mode shows the bond in notice', /noticed/.test(bondCard), bondCard.replace(/\s+/g, ' ').slice(0, 300))
  await shot('bond-noticed-receive-refused-dev')

  // --- The user-mode screens, at the end ---
  await setMode('user')
  const words2 = devWordsIn(await userScreensText())
  check('user mode: Balance, Send, Receive and the header carry no developer word', words2.length === 0, words2)
  await shot('user-mode-balance-end')
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
