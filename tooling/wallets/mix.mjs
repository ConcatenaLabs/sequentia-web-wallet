// The reliability run's `mix` lane: default-mode operations across the three wallets at once (the
// web wallet, Ambra browser, Ambra mobile), in the proportions a tester's day has, each followed to
// its end and held to the time the wallet told its user. One browser (the web wallet's page and
// Ambra browser's popup as two of its tabs) and one device; up to three operations run at a time,
// never two on one wallet.
//
// Operations (each a line of <work>/reliability-mix.jsonl):
//   trade     Trade tab: pay → get, to Received (the trade's end for its user), Settled or Returned.
//             The wallet states no time; after 10 minutes it says settling "is taking longer than
//             usual", so 600 s is its bound. Every asset both ways against USDX, BTC included.
//   payment   Send to another wallet's fresh receive code (`code`), to the BTC invoice its receive
//   receive   code carries for an amount (`invoice`, over Lightning), or to its bare address
//             (`address`): the payer's operation from Send to "Sent", the receiver's from Send
//             to its figure showing it. Held to what the review said: "in seconds" 60 s,
//             "after the next block, in about a minute" 180 s, "in a few minutes" 600 s ("in
//             about N minutes" 2N), "after a Bitcoin block" 3600 s.
//   closed    `code` paid into Ambra mobile while the app is closed (sent home, its process ended):
//             the receive is timed from opening the app again, held to "in seconds".
//   faucet    the faucet's button for an asset, to "Received …" (the receive card's "in seconds"),
//             or for BTC paid to the address, to the figure (after a Bitcoin block).
// A refusal before anything moved (the review, Send or the ticket saying why) is a clean return.
// Nothing is retried. A payment whose receiver never shows it in an hour is `failed`, and the
// run's end reads every wallet's figures and trades again, so a late one is told from a lost one.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Page, chromium } from '../cdp-page.mjs'
import { WebWallet } from './web.mjs'
import { AmbraBrowser } from './ambra-browser.mjs'
import { AmbraMobile } from './ambra-mobile.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function boundOf (said) {
  const s = String(said || '')
  if (/in seconds/i.test(s)) return 60
  if (/next block, in about a minute|about a minute/i.test(s)) return 180
  const w = s.match(/within (\d+) minutes/i); if (w) return 60 * Number(w[1])
  const m = s.match(/in about (\d+) minutes/i); if (m) return Math.max(600, 120 * Number(m[1]))
  if (/few minutes/i.test(s)) return 600
  if (/after a Bitcoin block/i.test(s)) return 3600
  return null
}

const PAIRS = ['GOLD', 'SILVR', 'OILX', 'EURX', 'tSEQ', 'BTC']
// A seeded shuffle, so a resumed run takes the same plan.
function rng (seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

// The plan: what each operation is, for `ops` records in all. `mix` gives the share of each kind.
export function plan (wallets, ops, seed = 1) {
  const r = rng(seed)
  const names = wallets.map((w) => w.name)
  const mobile = wallets.find((w) => w.kind === 'mobile')
  const out = []
  let recs = 0; let i = 0
  const pairs = []
  for (const a of names) for (const b of names) if (a !== b) pairs.push([a, b])
  const tradeLeg = Object.fromEntries(names.map((n) => [n, 0]))
  // The faucet pays each asset once per wallet; the drive's tabs carry the faucet token and are
  // paid every time, the phone asks as any tester does, so it asks once for each asset it lacks.
  // tSEQ is left out: the faucet pays it from a covenant that releases one payment at a time.
  const FAUCET = ['USDX', 'EURX', 'GOLD', 'SILVR', 'OILX', 'BTC']
  if (mobile) for (const a of ['EURX', 'GOLD', 'SILVR', 'OILX']) { out.push({ id: out.length + 1, op: 'faucet', wallet: mobile.name, asset: a }); recs++ }
  while (recs < ops) {
    const x = r()
    let op
    if (x < 0.42) {
      const w = names[i % names.length]; const k = tradeLeg[w]++
      const asset = PAIRS[Math.floor(k / 2) % PAIRS.length]
      op = { op: 'trade', wallet: w, pay: k % 2 ? asset : 'USDX', get: k % 2 ? 'USDX' : asset, sell: k % 2 === 1 }
      recs += 1
    } else if (x < 0.75) {
      const [from, to] = pairs[i % pairs.length]
      const asset = r() < 0.75 ? 'USDX' : ['GOLD', 'EURX', 'SILVR'][Math.floor(r() * 3)]
      op = { op: 'payment', how: 'code', from, to, asset }
      recs += 2
    } else if (x < 0.81) {
      const [from, to] = pairs[(i * 5) % pairs.length]
      op = { op: 'payment', how: 'invoice', from, to, asset: 'BTC', amount: '0.00001' }
      recs += 2
    } else if (x < 0.86) {
      const [from, to] = pairs[(i * 7) % pairs.length]
      op = { op: 'payment', how: 'address', from, to, asset: 'USDX', amount: '1' }
      recs += 2
    } else if (x < 0.89 && mobile) {
      const from = names.filter((n) => n !== mobile.name)[i % (names.length - 1)]
      op = { op: 'payment', how: 'closed', from, to: mobile.name, asset: 'USDX', amount: '1' }
      recs += 2
    } else {
      const w = names[i % names.length]
      if (mobile && w === mobile.name) { i++; continue }
      op = { op: 'faucet', wallet: w, asset: FAUCET[Math.floor(r() * FAUCET.length)] }
      recs += 1
    }
    out.push({ id: out.length + 1, ...op }); i++
  }
  return out
}

export async function runMix ({ work, specs, ops, ext, base, phrases, seed, say }) {
  const out = join(work, 'reliability-mix.jsonl')
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])
  // A line the drive itself could not make an operation of (`drive_skip`: nothing a person did)
  // does not count towards `ops`.
  let n = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).filter((l) => { const x = JSON.parse(l); return !x.drive_skip && !x.drive_error }).length : 0
  const record = (o) => {
    if (!o.drive_skip && !o.drive_error) n++
    const line = { n, at: new Date().toISOString(), ...o }
    appendFileSync(out, JSON.stringify(line) + '\n')
    say(`#${n} [${o.id}] ${o.op} ${o.wallet || o.from + '→' + o.to} ${o.how || o.pair || o.asset || ''} ${o.outcome} ${o.seconds}s${o.within === false ? ' OVER ' + o.bound + 's' : ''} ${(o.said || '').slice(0, 200)}`)
  }
  const phraseOf = (name) => { const f = join(phrases, name + '.phrase'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : null }
  const keep = (w) => { if (w.created && w.phrase) writeFileSync(join(phrases, w.name + '.phrase'), w.phrase + '\n', { mode: 0o600 }) }

  const browser = new Page(chromium(), { profile: join(work, 'profiles', 'mix'), ext })
  await browser.open()
  writeFileSync(join(work, 'browser.pid'), String(browser.proc.pid))
  // A browser stopped by an earlier run reopens its tabs, and a wallet tab among them holds the
  // web wallet's one-tab lock: every page but the first is closed.
  try {
    const me = (await browser.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await browser.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await browser.send('Target.closeTarget', { targetId: t.targetId })
  } catch (e) { say('closing other tabs: ' + e.message) }
  const wallets = []
  try {
    for (const s of specs) {
      const [kind, name] = s.split(':')
      const w = kind === 'web' ? new WebWallet(browser, { name, base, phrase: phraseOf(name) })
        : kind === 'browser' ? new AmbraBrowser(browser, { name, phrase: phraseOf(name) })
          : kind === 'mobile' ? new AmbraMobile({ name }) : null
      if (!w) throw new Error('no wallet kind ' + kind)
      await w.open(); keep(w); wallets.push(w)
      say(`${kind} ${name} open`)
    }
    const byName = Object.fromEntries(wallets.map((w) => [w.name, w]))
    const todo = plan(wallets, ops, seed).filter((o) => !done.has(o.id))
    writeFileSync(join(work, 'plan.json'), JSON.stringify(plan(wallets, ops, seed), null, 1))
    const busy = new Set(); const watches = []
    // What each wallet's last purchase of an asset brought: its sale sells that back.
    const got = {}
    const needs = (o) => o.op === 'payment' ? [o.from, o.to] : [o.wallet]
    // A wallet taken for one step of a watch (a figure read), between operations.
    // A watch waiting for its read goes before any new operation on that wallet; a receiver under
    // an address watch takes no second payment to an address until the first has shown.
    const wanted = new Map(); const watched = new Set()
    const lock = async (names, fn) => {
      names.forEach((w) => wanted.set(w, (wanted.get(w) || 0) + 1))
      try {
        while (names.some((w) => busy.has(w))) await sleep(500)
        names.forEach((w) => busy.add(w))
      } finally { names.forEach((w) => wanted.set(w, wanted.get(w) - 1)) }
      try { return await fn() } finally { names.forEach((w) => busy.delete(w)) }
    }
    const free = (o) => needs(o).every((w) => !busy.has(w) && !wanted.get(w)) && !(o.how === 'address' && watched.has(o.to))
    const take = () => { const i = todo.findIndex(free); return i < 0 ? null : todo.splice(i, 1)[0] }
    const worker = async () => {
      while (todo.length && n < ops) {
        const o = take()
        if (!o) { await sleep(1000); continue }
        needs(o).forEach((w) => busy.add(w))
        try { await run(o, byName, record, (step) => appendFileSync(join(work, 'steps.log'), `${new Date().toISOString()} [${o.id}] ${step}\n`), (p) => watches.push(p), got, lock, watched) } catch (e) {
          record({ id: o.id, op: o.op === 'payment' ? 'payment' : o.op, wallet: o.wallet, from: o.from, to: o.to, how: o.how, asset: o.asset, outcome: 'failed', said: 'drive: ' + String(e.message).slice(0, 300), seconds: 0, drive_error: true })
        } finally { needs(o).forEach((w) => busy.delete(w)) }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    await Promise.all(watches)
    // The end: every wallet's trades and figures, read again.
    const end = {}
    for (const w of wallets) {
      end[w.name] = { kind: w.kind, trades: await w.trades().catch((e) => 'ERR ' + e.message) }
      for (const tk of ['USDX', 'BTC', 'GOLD', 'SILVR', 'OILX', 'EURX', 'tSEQ']) end[w.name][tk] = await w.figure(tk).catch(() => null)
    }
    writeFileSync(join(work, 'end.json'), JSON.stringify(end, null, 1))
    say('end: ' + JSON.stringify(end).slice(0, 2000))
  } finally {
    await browser.stop()
  }
}

const kindOf = (w) => w.kind
const fmt = (x) => String(Number(x.toPrecision(4)))

// Each wallet call of an operation, named in <work>/steps.log as it starts, and bounded: a call
// that never answers fails its operation as the drive's, instead of holding its wallets for good.
const bounded = (trace) => (label, p, ms = 1500000) => { trace(label); let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(label + ' gave no answer in ' + ms / 1000 + ' s')), ms) })]).finally(() => clearTimeout(t)) }

async function run (o, W, record, trace, later, got, lock, watched) {
  const S = bounded(trace)
  if (o.op === 'faucet') {
    const w = W[o.wallet]
    const before = await S('figure', w.figure(o.asset))
    const r = await S('faucet', w.faucet(o.asset))
    if (r.claimed) { record({ id: o.id, op: 'faucet', wallet: o.wallet, kind: kindOf(w), asset: o.asset, outcome: 'refused', said: r.said, seconds: 0, drive_skip: true }); return }
    let outcome = /^Received/.test(r.said) ? 'settled' : /already|once per wallet/i.test(r.said) ? 'refused' : /sent|arrives after|appear/i.test(r.said) ? 'sent' : 'failed'
    let seconds = r.seconds; let bound = 60
    if (outcome === 'sent') {
      // Paid to the address: the end is the figure, held to what the faucet's line said.
      bound = boundOf(r.said) || 3600
      const t = Date.now() - r.seconds * 1000
      const watch = async () => {
        while (Date.now() - t < 3600000) { if ((await w.figure(o.asset, { quiet: w.kind !== 'mobile' })) > before) { outcome = 'settled'; break } await sleep(15000) }
        seconds = (Date.now() - t) / 1000
        if (outcome !== 'settled') outcome = 'failed'
        record({ id: o.id, op: 'faucet', wallet: o.wallet, kind: kindOf(w), asset: o.asset, outcome, said: r.said, seconds, bound, within: outcome === 'settled' ? seconds <= bound : false })
      }
      // A browser wallet's figure is read as drawn, so the watch holds nothing and the wallet goes
      // on with other steps; the phone has one screen, so it waits there.
      if (w.kind === 'mobile') await watch(); else later(watch().catch((e) => record({ id: o.id, op: 'faucet', wallet: o.wallet, kind: kindOf(w), asset: o.asset, outcome: 'failed', said: 'drive: ' + e.message, seconds: 0, drive_error: true })))
      return
    }
    record({ id: o.id, op: 'faucet', wallet: o.wallet, kind: kindOf(w), asset: o.asset, outcome, said: r.said, seconds, bound, within: outcome === 'settled' ? seconds <= bound : outcome === 'refused' ? null : false })
    return
  }
  if (o.op === 'trade') {
    const w = W[o.wallet]
    // BTC is bought for 25 USDX: less is refused as too small.
    let amount = o.sell ? null : (o.get === 'BTC' ? '25' : '3')
    if (o.sell) {
      const held = await S('figure', w.figure(o.pay))
      if (!(held > 0)) { record({ id: o.id, op: 'trade', wallet: o.wallet, kind: kindOf(w), pair: `${o.pay}→${o.get}`, outcome: 'refused', said: `no ${o.pay} shown to sell`, seconds: 0, drive_skip: true }); return }
      const last = got[o.wallet + ':' + o.pay]
      amount = fmt(Math.min(held, last || held / 10) * 0.98)
    }
    const r = await S('trade', w.trade(o.pay, o.get, amount))
    if (r.refused) { record({ id: o.id, op: 'trade', wallet: o.wallet, kind: kindOf(w), pair: `${o.pay}→${o.get}`, amount, outcome: 'refused', said: r.refused, seconds: r.priceSeconds, price_seconds: r.priceSeconds }); return }
    const bought = String(r.ticket).match(/You receive ([0-9.,]+) /)
    if (!o.sell && bought) got[o.wallet + ':' + o.get] = Number(bought[1].replace(/,/g, ''))
    const outcome = /Settled/.test(r.final || '') ? 'settled' : /Returned/.test(r.final || '') ? 'returned' : /Failed|failed/.test(r.final || '') ? 'failed' : r.received != null ? 'received' : 'pending'
    const usable = r.received != null ? r.received : outcome === 'returned' ? r.seconds : null
    record({ id: o.id, op: 'trade', wallet: o.wallet, kind: kindOf(w), pair: `${o.pay}→${o.get}`, amount, outcome, said: r.ticket.slice(0, 300), states: r.states, final: r.final,
      price_seconds: r.priceSeconds, received_seconds: r.received, seconds: usable ?? r.seconds, bound: 600, within: usable != null ? usable <= 600 : false, row: r.row })
    return
  }
  // A payment, and the receiver's side of it.
  const from = W[o.from]; const to = W[o.to]
  // A payment to an address shows only after the operator's settlement and a block, about half an
  // hour live: it goes in OILX, which no other payment moves, so its watch can let both wallets go
  // on with other operations and still tell its arrival from theirs.
  if (o.how === 'address') { o = { ...o, asset: 'OILX', amount: '1' } }
  let recipient; const amount = o.amount || (o.asset === 'USDX' ? '1' : o.asset === 'EURX' ? '1' : '0.0001')
  if (o.how === 'invoice') recipient = await S('invoice ' + o.to, to.invoice(amount))
  else {
    const code = await S('code ' + o.to, to.code())
    recipient = o.how === 'address' ? decodeURIComponent(code.replace(/^bitcoin:/i, '').split('?')[0]).toLowerCase() : code
  }
  const before = await S('figure ' + o.to, to.figure(o.asset))
  let closedAt = null
  let closedHow = null
  if (o.how === 'closed') { const c = await S('close', to.close()); closedAt = Date.now(); closedHow = c.process; if (!c.killed) throw new Error('the app did not close') }
  const base = { id: o.id, from: o.from, to: o.to, how: o.how, asset: o.asset, amount, kind: kindOf(from) }
  const s = await S('send ' + o.from, from.send(recipient, o.asset, amount), 2400000)
  if (s.refused) {
    record({ ...base, op: 'payment', outcome: 'refused', said: s.refused, seconds: 0 })
    if (o.how === 'closed') await to.open()
    // The receiver had nothing coming: its side ends with the refusal.
    record({ ...base, op: 'receive', kind: kindOf(to), outcome: 'refused', said: 'nothing was sent', seconds: 0 })
    return
  }
  const bound = boundOf(s.review) ?? boundOf(s.status)
  const sent = /^(Sent|Paid)/.test(s.status)
  record({ ...base, op: 'payment', outcome: sent ? 'settled' : /try again|nothing was sent|not sent|came back|couldn't/i.test(s.status) ? 'refused' : 'failed',
    said: s.review.slice(0, 200) + ' → ' + s.status, stated: s.review.match(/It arrives[^.]*\./)?.[0] || null, seconds: s.seconds, bound, within: sent && bound ? s.seconds <= bound : null })
  // A payer that never answered may still have paid: its receiver is watched as for a sent one.
  const silent = /^no answer/.test(s.status)
  if (!sent && !silent) { if (o.how === 'closed') await to.open(); record({ ...base, op: 'receive', kind: kindOf(to), outcome: /came back|nothing/i.test(s.status) ? 'refused' : 'failed', said: 'the payer said: ' + s.status, seconds: 0 }); return }
  if (o.how === 'address') {
    const t0 = s.clickedAt
    watched.add(o.to)
    later((async () => {
      // Arrival: the figure 0.9 or more above the lowest it has read since the payment (a sale of
      // OILX in the meantime lowers it; a purchase adds a few hundredths).
      let low = before; let seen = null
      while (Date.now() - t0 < 7200000) {
        const f = await lock([o.to], () => to.figure(o.asset)).catch(() => null)
        if (f != null) { low = Math.min(low, f); if (f - low >= 0.9) { seen = f; break } }
        await sleep(30000)
      }
      const secs = (Date.now() - t0) / 1000
      watched.delete(o.to)
      record({ ...base, op: 'receive', kind: kindOf(to), outcome: seen != null ? 'settled' : 'failed', said: seen != null ? `${o.to} shows ${seen} ${o.asset} (lowest since the payment ${low}, was ${before})` : `${o.to} never showed it in two hours (was ${before})`,
        seconds: secs, bound, within: seen != null && bound ? secs <= bound : false })
    })())
    return
  }
  let t0 = s.clickedAt; let opened = null
  if (o.how === 'closed') { await sleep(20000); const t = Date.now(); await S('open ' + o.to, to.open()); opened = (Date.now() - t) / 1000; t0 = t }
  // BTC over Lightning arrives less the receiving side's fee: half the amount counts as its arrival,
  // and the line says what came.
  const want = before + Number(amount) * (o.asset === 'BTC' ? 0.5 : 1) - 1e-9
  let seen = null
  // A payer that never answered is watched for 20 minutes, a sent payment for an hour.
  while (Date.now() - t0 < (silent ? 1200000 : 3600000)) {
    const f = await S('figure ' + o.to, to.figure(o.asset))
    if (f >= want) { seen = f; break }
    await sleep(o.how === 'address' ? 10000 : 1500)
  }
  const secs = (Date.now() - t0) / 1000
  const rb = o.how === 'closed' ? 60 : bound
  record({ ...base, op: 'receive', kind: kindOf(to), outcome: seen != null ? 'settled' : 'failed', said: seen != null ? `${o.to} shows ${seen} ${o.asset} (was ${before}: +${Number((seen - before).toPrecision(8))} of ${amount})${opened != null ? `; opened ${opened}s, closed ${((t0 - closedAt) / 1000).toFixed(0)}s before, its process ${closedHow}` : ''}` : `${o.to} never showed it in ${silent ? '20 minutes' : 'an hour'} (was ${before})`,
    seconds: secs, bound: rb, within: seen != null && rb ? secs <= rb : (seen != null ? null : false) })
}

// The verdict of a run, from its lines: per wallet and in all, how many ended (settled, received,
// returned, or refused before anything moved), how many of the timed ones were within the time
// stated, what was lost (sent and never shown, a trade never ended), and the failures and the
// operations over their time grouped by what was said.
export function summarize (lines) {
  // What the drive could not do (a skip, a drive error) is not an operation of the wallet's.
  const driveErrors = lines.filter((l) => l.drive_error).length
  lines = lines.filter((l) => !l.drive_skip && !l.drive_error)
  const ended = (l) => ['settled', 'received', 'returned', 'refused'].includes(l.outcome)
  const group = (ls) => {
    const timed = ls.filter((l) => l.within === true || l.within === false)
    const within = timed.filter((l) => l.within === true)
    const kinds = {}
    for (const l of ls) { const k = `${l.op}${l.how ? ':' + l.how : ''}`; kinds[k] = kinds[k] || { n: 0, within: 0, timed: 0, over: 0, refused: 0, failed: 0, secs: [] }
      const g = kinds[k]; g.n++; if (l.within != null) g.timed++; if (l.within === true) g.within++; if (l.within === false) g.over++; if (l.outcome === 'refused') g.refused++; if (l.outcome === 'failed') g.failed++; if (l.seconds) g.secs.push(l.seconds) }
    for (const g of Object.values(kinds)) { const s = g.secs.sort((a, b) => a - b); g.median = s.length ? s[Math.floor(s.length / 2)] : null; g.p90 = s.length ? s[Math.floor(s.length * 0.9)] : null; g.max = s.length ? s[s.length - 1] : null; delete g.secs }
    return { n: ls.length, ended: ls.filter(ended).length, timed: timed.length, within: within.length, pct: timed.length ? Math.round(1000 * within.length / timed.length) / 10 : null, kinds }
  }
  const by = (f) => { const m = {}; for (const l of lines) (m[f(l)] = m[f(l)] || []).push(l); return m }
  const actor = (l) => l.kind || 'unknown'
  const wallets = Object.fromEntries(Object.entries(by(actor)).map(([k, v]) => [k, group(v)]))
  const cause = (l) => String(l.said || '').replace(/^.*→ /, '').replace(/[0-9][0-9,.]*/g, '#').replace(/\s+/g, ' ').slice(0, 120)
  const bad = lines.filter((l) => l.outcome === 'failed' || l.outcome === 'pending' || l.within === false || l.outcome === 'refused')
  const causes = {}
  for (const l of bad) { const k = `${l.outcome}${l.within === false && l.outcome !== 'failed' ? ' (over ' + l.bound + ' s)' : ''} ${l.op}${l.how ? ':' + l.how : ''}: ${cause(l)}`; causes[k] = (causes[k] || 0) + 1 }
  return { all: group(lines), wallets, driveErrors, unshown: lines.filter((l) => l.outcome === 'failed' && l.op === 'receive').length, causes: Object.entries(causes).sort((a, b) => b[1] - a[1]) }
}
