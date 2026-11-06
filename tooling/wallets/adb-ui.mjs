// The smallest Android driver the reliability run needs for Ambra mobile: the screen as the
// accessibility tree reads it (`uiautomator dump`), taps by what a node says, typed text, and the
// app's logcat. A person's taps, nothing inside the app: the released APK as installed.
//
//   ADB=/path/to/adb (default ~/Android/Sdk/platform-tools/adb), ANDROID_SERIAL picks the device.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ADB = process.env.ADB || join(homedir(), 'Android/Sdk/platform-tools/adb')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function adb (args, { timeout = 60000 } = {}) {
  if (!existsSync(ADB)) return Promise.reject(new Error('no adb at ' + ADB + ': set ADB'))
  return new Promise((ok, no) => execFile(ADB, args, { timeout, maxBuffer: 64 << 20 }, (e, out, err) => e ? no(new Error(`adb ${args.join(' ')}: ${(err || e.message).toString().slice(0, 300)}`)) : ok(out.toString())))
}
export const shell = (cmd, o) => adb(['shell', cmd], o)

const unescape = (s) => s.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// The screen: every node with what it says (text, else its description), its bounds and centre,
// and whether it takes taps or text.
export async function screen () {
  let xml = ''
  for (let i = 0; i < 4 && !xml.includes('<hierarchy'); i++) {
    // A screen that is still moving can make the dump fail ("could not get idle state").
    await shell('uiautomator dump /sdcard/rb-ui.xml >/dev/null 2>&1; cat /sdcard/rb-ui.xml').then((x) => { xml = x }).catch(() => {})
    if (!xml.includes('<hierarchy')) await sleep(700)
  }
  const nodes = []
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!b) continue
    const [x1, y1, x2, y2] = b.slice(1).map(Number)
    nodes.push({ say: unescape(a.text || a['content-desc'] || ''), cls: a.class || '', clickable: a.clickable === 'true', edit: /EditText/.test(a.class || ''),
      focused: a.focused === 'true', checked: a.checked === 'true', x: (x1 + x2) >> 1, y: (y1 + y2) >> 1, x1, y1, x2, y2 })
  }
  return nodes
}
export const textOf = (nodes) => nodes.map((n) => n.say).filter(Boolean).join('\n')
const match = (n, re) => typeof re === 'string' ? n.say === re : re.test(n.say)

export async function find (re, { clickable = null, nodes = null } = {}) {
  const ns = nodes || await screen()
  return ns.find((n) => match(n, re) && (clickable == null || n.clickable === clickable)) || null
}
// Waits for a node saying `re` (a string is matched whole); -> the node.
export async function waitFor (re, ms = 30000, opts = {}) {
  const until = Date.now() + ms
  let last = ''
  while (Date.now() < until) {
    const ns = await screen()
    const n = ns.find((n) => match(n, re) && (opts.clickable == null || n.clickable === opts.clickable))
    if (n) return n
    last = textOf(ns)
    await sleep(opts.every || 1000)
  }
  throw new Error(`waited ${ms} ms for ${re} (screen: ${last.replace(/\n/g, ' | ').slice(0, 400)})`)
}
// Waits for any of several patterns; -> { i, node, nodes }.
export async function waitAny (res, ms = 30000, every = 1000) {
  const until = Date.now() + ms
  let last = ''
  while (Date.now() < until) {
    const ns = await screen()
    for (let i = 0; i < res.length; i++) { const n = ns.find((n) => match(n, res[i])); if (n) return { i, node: n, nodes: ns } }
    last = textOf(ns)
    await sleep(every)
  }
  throw new Error(`waited ${ms} ms for any of ${res.join(' / ')} (screen: ${last.replace(/\n/g, ' | ').slice(0, 400)})`)
}
export const tapAt = (x, y) => shell(`input tap ${x} ${y}`)
// A node tapped where a finger lands on it: at its centre, kept above the gesture area at the
// screen's foot (below about y 2250 on a 2400-pixel screen), where a tap is lost.
export const tapNode = (n) => tapAt(n.x, Math.max(n.y1 + 5, Math.min(n.y, 2245)))
// A tap near the screen's foot lands in the system's gesture area: those nodes are tapped near their top.
export async function tap (re, ms = 30000, opts = {}) { const n = await waitFor(re, ms, { clickable: true, ...opts }); await tapNode(n); return n }
export const back = () => shell('input keyevent 4')
export const swipeUp = () => shell('input swipe 540 1800 540 600 300')
export const swipeDown = () => shell('input swipe 540 600 540 1800 300')
// Text into the focused field, in single quotes for the device's shell (where nothing but a
// quote is special) and with `input text`'s own %s for a space.
export async function type (s) {
  const str = String(s)
  for (let i = 0; i < str.length; i += 300) {
    const part = str.slice(i, i + 300).replace(/%/g, '%%').replace(/ /g, '%s').replace(/'/g, "'\\''")
    await shell(`input text '${part}'`)
  }
}
// Empties the focused field: to its end, then deletes until the focused field reads empty.
export async function clearField () {
  await shell('input keyevent KEYCODE_MOVE_END')
  for (let i = 0; i < 8; i++) {
    const f = (await screen()).find((n) => n.edit && n.focused)
    if (!f || !f.say) return
    await shell('input keyevent ' + Array(Math.min(f.say.length + 5, 150)).fill('KEYCODE_DEL').join(' '))
  }
}
// Waits until no passing note ("… copied") lies over the tabs.
export async function noSnack (ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (!(await screen()).some((n) => /copied/i.test(n.say))) return; await sleep(500) }
}
// Scrolls up until `re` shows, or gives up after `tries` swipes; -> the node or null.
export async function scrollTo (re, tries = 6, dir = 'up') {
  for (let i = 0; i <= tries; i++) {
    const n = await find(re)
    if (n && n.y > 150 && n.y < 2140) return n
    if (i < tries) { await (dir === 'up' ? swipeUp() : swipeDown()); await sleep(700) }
  }
  return null
}
export const clipboard = async () => (await shell("cmd clipboard get-text 2>/dev/null || true")).trim()
export const logcat = (since) => adb(['logcat', '-d', ...(since ? ['-T', since] : ['-t', '2000']), '-s', 'flutter:I', 'AmbraLeafJob:I', 'bark:I'])
export const deviceTime = async () => (await shell("date +'%m-%d %H:%M:%S.000'")).trim()
