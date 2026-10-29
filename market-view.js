// The market of a pair, as both modes of the Trade tab show it: a price chart over a few ranges,
// the last price and its change over the last 24 hours, the best bid and ask with a depth bar, and
// the market's recent trades. Every figure comes from SeqDEX's relay, whose one trade log per market
// holds the trades of every rail (its `trades`, `candles` and `ticker`), so every surface that reads
// the relay shows the same numbers.
//
// Default mode shows the market and nothing of how a trade settles; developer mode adds each
// trade's rail and the book's depth by rail. Every word default mode can show is in MARKET_WORDS,
// checked against USER_MODE_FORBIDDEN_WORDS (market-view.test.mjs).
//
// The relay keeps a market in one direction and serves it in either; the view asks in the pair's
// display direction (`ctx.pairOf`, the composer's canonical "1 base = N quote"). A relay that answers
// no `ticker` keeps each direction's trades apart: both directions are read and put together.

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

export const MARKET_WORDS = Object.freeze({
  ranges: { '1D': '1D', '1W': '1W', '1M': '1M' },
  ago: { '1D': '24 hours ago', '1W': '7 days ago', '1M': '30 days ago' },
  now: 'now',
  change24: '24h',
  noDay: 'No trades in the last 24 hours',
  lastTrade: (price, ago) => `Last trade ${price}, ${ago} ago`,
  noTrades: 'No trades yet',
  noRange: 'No trades in this range',
  bid: 'Best bid',
  ask: 'Best ask',
  noBook: 'Nobody is buying or selling right now',
  buyers: 'Buyers',
  sellers: 'Sellers',
  trades: 'Recent trades',
  price: 'Price',
  amount: 'Amount',
  time: 'Time',
  high: 'High',
  low: 'Low',
  volume: 'Volume',
})

// Developer mode's words, never shown in default mode.
export const MARKET_DEV_WORDS = Object.freeze({
  rail: 'Rail',
  bookByRail: 'Book by rail (bids · depth, asks · depth)',
})

// The chart's ranges: the span shown and the candle each point is.
export const RANGES = Object.freeze([
  { key: '1D', span: 86400, interval: 900 },
  { key: '1W', span: 7 * 86400, interval: 7200 },
  { key: '1M', span: 30 * 86400, interval: 43200 },
])

// What developer mode calls each rail (the relay's names).
export const RAIL_NAMES = Object.freeze({
  'onchain-fill': 'on-chain covenant', 'covenant-round': 'covenant in a round', 'clearing-round': 'clearing round',
  'leaf-resting': 'resting leaf', interactive: 'interactive', cross: 'cross-chain', lightning: 'Lightning',
  'leaf-maker': 'in-tree maker', 'btc-gateway': 'BTC desk',
})

// The rail an offer of the book settles on.
export function offerRail (o) {
  if (!o) return 'other'
  if (o.resting_leaf || o.restingLeaf) return 'leaf-resting'
  if (o.covenant) return 'onchain-fill'
  if (o.lightning) return 'lightning'
  if (o.cross_chain || o.crossChain) return 'cross'
  if (o.same_chain || o.sameChain) return 'interactive'
  return 'other'
}

// A price in quote atoms per base atom, in whole units: quote per whole base.
export function unitPrice (atomPrice, basePrec, quotePrec) {
  const p = Number(atomPrice)
  return p > 0 ? p * Math.pow(10, (basePrec || 0) - (quotePrec || 0)) : 0
}

// A trade or candle read in the other direction of its market.
export function flipTrade (t) {
  const p = Number(t.price)
  return { ...t, price: p > 0 ? 1 / p : 0, size: t.quote_size ?? t.size, quote_size: t.size, side: t.side === 'buy' ? 'sell' : t.side === 'sell' ? 'buy' : t.side }
}
export function flipCandle (c) {
  const iv = (x) => { const n = Number(x); return n > 0 ? 1 / n : 0 }
  return { t: c.t, o: iv(c.o), c: iv(c.c), h: iv(c.l), l: iv(c.h), v: c.v }
}

// Candles from trades (oldest first), for a relay that serves each direction apart.
export function candlesOf (trades, interval) {
  const out = []
  for (const t of trades) {
    const b = Math.floor((t.ts || 0) / interval) * interval
    const p = Number(t.price)
    let c = out[out.length - 1]
    if (!c || c.t !== b) { c = { t: b, o: p, h: p, l: p, c: p, v: 0 }; out.push(c) }
    c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.v += Number(t.size || 0)
  }
  return out
}

// The last 24 hours, from the trades (oldest first, unit prices): last price, change, high, low,
// volume (base atoms), or `inDay` false with the last trade's price and time.
export function dayOf (trades, nowSec) {
  const last = trades[trades.length - 1] || null
  const win = trades.filter((t) => (t.ts || 0) >= nowSec - 86400)
  if (!win.length) return { inDay: false, last: last ? last.p : null, lastT: last ? last.ts : null }
  let hi = -Infinity, lo = Infinity, vol = 0n
  for (const t of win) { hi = Math.max(hi, t.p); lo = Math.min(lo, t.p); vol += big(String(t.size || 0)) }
  const open = win[0].p, close = win[win.length - 1].p
  return { inDay: true, last: close, lastT: last.ts, hi, lo, vol, count: win.length, changePct: open > 0 ? (close - open) / open * 100 : 0 }
}

// The chart's points over a range: each candle's close at its end, the close before the range
// carried in at its start, and the last close carried to now. Empty when nothing ever traded.
export function seriesOf (candles, range, nowSec) {
  const start = nowSec - range.span
  const before = candles.filter((c) => c.t + range.interval <= start)
  const inside = candles.filter((c) => c.t + range.interval > start)
  const pts = []
  if (before.length) pts.push({ t: start, p: before[before.length - 1].c })
  for (const c of inside) pts.push({ t: Math.max(start, Math.min(nowSec, c.t + range.interval)), p: c.c, o: c.o, h: c.h, l: c.l })
  if (pts.length) pts.push({ t: nowSec, p: pts[pts.length - 1].p })
  return { pts, inRange: inside.length, start }
}

// The chart, as SVG text: a line of the price over the range with its area below, its high and low
// marked on the right, the range's start and end below.
export function chartSvg (series, opts = {}) {
  const W = opts.width || 320, H = opts.height || 120, padR = 64, padB = 16
  const { pts, start } = series
  const end = pts.length ? pts[pts.length - 1].t : start + 1
  if (!pts.length) return ''
  let min = Math.min(...pts.map((x) => x.p)), max = Math.max(...pts.map((x) => x.p))
  if (min === max) { min = min * 0.99; max = max * 1.01 || 1 }
  const x = (t) => ((t - start) / Math.max(1, end - start)) * (W - padR)
  const y = (p) => 4 + (1 - (p - min) / (max - min)) * (H - padB - 8)
  // A step line: a price holds until the next trade.
  let d = ''
  pts.forEach((q, i) => { d += i === 0 ? `M${x(q.t).toFixed(1)},${y(q.p).toFixed(1)}` : `H${x(q.t).toFixed(1)}V${y(q.p).toFixed(1)}` })
  const up = pts[pts.length - 1].p >= pts[0].p
  const col = up ? 'var(--mv-up, #3ddc84)' : 'var(--mv-down, #f0a35e)'
  const area = `${d}V${(H - padB).toFixed(1)}H${x(pts[0].t).toFixed(1)}Z`
  const fmt = opts.fmt || ((v) => String(v))
  const lbl = (t) => opts.timeLabel ? opts.timeLabel(t) : ''
  return `<svg class="mv-chart" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || '')}">`
    + `<path d="${area}" fill="${col}" fill-opacity="0.12" stroke="none"/>`
    + `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`
    + `<text x="${W - padR + 4}" y="${y(max) + 4}" class="mv-ax">${esc(fmt(max))}</text>`
    + `<text x="${W - padR + 4}" y="${y(min) + 4}" class="mv-ax">${esc(fmt(min))}</text>`
    + `<text x="0" y="${H - 3}" class="mv-ax">${esc(lbl(start))}</text>`
    + `<text x="${W - padR}" y="${H - 3}" class="mv-ax" text-anchor="end">${esc(lbl(end))}</text>`
    + '</svg>'
}

export function esc (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

export function agoText (tSec, nowSec) {
  const d = Math.max(0, nowSec - (tSec || 0)), u = (n, w) => n + ' ' + w + (n === 1 ? '' : 's')
  return d >= 86400 ? u(Math.floor(d / 86400), 'day') : d >= 3600 ? u(Math.floor(d / 3600), 'hour') : d >= 60 ? u(Math.floor(d / 60), 'minute') : u(Math.max(1, d), 'second')
}

export function fmtPrice (v) {
  if (!(v > 0) || !isFinite(v)) return '-'
  const digits = v >= 1000 ? 2 : v >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(v)) + 2)
  return Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })
}

// Reads a market from the relay in the pair's direction: { trades (oldest first), candles by range
// key, ticker or null, book: {bid, ask, bidDepth, askDepth, byRail} }.
export async function readMarket (relay, base, quote, rangeKey, fetchImpl = fetch) {
  const get = async (path) => {
    try { const r = await fetchImpl(relay + path, { cache: 'no-store' }); return r.ok ? await r.json() : null } catch { return null }
  }
  const m = (b, q) => '/v1/market/' + encodeURIComponent(b) + '/' + encodeURIComponent(q)
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0]
  const [ticker, tr, cd, b1, b2] = await Promise.all([
    get(m(base, quote) + '/ticker'), get(m(base, quote) + '/trades?limit=200'),
    get(m(base, quote) + `/candles?interval=${range.interval}&limit=${Math.ceil(range.span / range.interval) + 50}`),
    get(m(base, quote) + '/orderbook'), get(m(quote, base) + '/orderbook'),
  ])
  let trades = (tr && Array.isArray(tr.trades)) ? tr.trades : []
  let candles = (cd && Array.isArray(cd.candles)) ? cd.candles : []
  if (!ticker) {
    // A relay that keeps each direction's trades apart: read the other direction too.
    const tr2 = await get(m(quote, base) + '/trades?limit=200')
    const other = ((tr2 && tr2.trades) || []).map(flipTrade)
    if (other.length) {
      trades = [...trades, ...other].sort((a, b) => (a.ts || 0) - (b.ts || 0))
      candles = candlesOf(trades, range.interval)
    }
  }
  trades.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  return { trades, candles, ticker, offers: [...((b1 && b1.offers) || []), ...((b2 && b2.offers) || [])], range }
}

// The book's best bid and ask (unit prices) and its depth on each side (base units), from the
// offers of both orientations; by rail too, for developer mode.
export function bookOf (offers, base, quote, bp, qp, nowSec) {
  let bid = null, ask = null, bidDepth = 0, askDepth = 0
  const byRail = {}
  const seen = new Set()
  for (const o of offers || []) {
    const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); if (exp && exp <= nowSec) continue
    const id = (o.maker_pubkey || o.makerPubkey) + ':' + (o.offer_id || o.offerId); if (seen.has(id)) continue; seen.add(id)
    const oa = o.offer_asset || o.offerAsset, wa = o.want_asset || o.wantAsset
    const oA = Number(o.offer_amount || o.offerAmount || 0), wA = Number(o.want_amount || o.wantAmount || 0)
    let baseU, quoteU, isAsk
    if (oa === base && wa === quote) { baseU = oA / 10 ** bp; quoteU = wA / 10 ** qp; isAsk = true }
    else if (oa === quote && wa === base) { baseU = wA / 10 ** bp; quoteU = oA / 10 ** qp; isAsk = false }
    else continue
    if (!(baseU > 0 && quoteU > 0)) continue
    const p = quoteU / baseU
    if (isAsk) { askDepth += baseU; if (ask == null || p < ask) ask = p } else { bidDepth += baseU; if (bid == null || p > bid) bid = p }
    const r = byRail[offerRail(o)] || (byRail[offerRail(o)] = { bids: 0, asks: 0, bidDepth: 0, askDepth: 0 })
    if (isAsk) { r.asks++; r.askDepth += baseU } else { r.bids++; r.bidDepth += baseU }
  }
  return { bid, ask, bidDepth, askDepth, byRail }
}

// The view's text (HTML) for a market read with readMarket. ctx: { meta(hex) -> {ticker,
// precision}, fmtAtoms(atoms, precision), dev (bool), now (unix seconds), base, quote }
export function marketHtml (m, ctx) {
  const W = MARKET_WORDS
  const now = ctx.now || Math.floor(Date.now() / 1000)
  const bm = ctx.meta(ctx.base) || {}, qm = ctx.meta(ctx.quote) || {}
  const bp = ctx.base === 'BTC' ? 8 : (bm.precision ?? 0), qp = ctx.quote === 'BTC' ? 8 : (qm.precision ?? 0)
  const bt = ctx.base === 'BTC' ? 'BTC' : (bm.ticker || String(ctx.base).slice(0, 8)), qt = ctx.quote === 'BTC' ? 'BTC' : (qm.ticker || String(ctx.quote).slice(0, 8))
  const up = (p) => unitPrice(p, bp, qp)
  const trades = (m.trades || []).map((t) => ({ ...t, p: up(t.price) })).filter((t) => t.p > 0)
  const day = dayOf(trades, now)
  const range = m.range || RANGES[0]
  const candles = (m.candles || []).map((c) => ({ t: c.t, o: up(c.o), h: up(c.h), l: up(c.l), c: up(c.c), v: c.v }))
  const series = seriesOf(candles, range, now)
  const book = bookOf(m.offers, ctx.base, ctx.quote, bp, qp, now)
  const amt = (atoms, prec) => ctx.fmtAtoms(big(String(Math.round(Number(atoms) || 0))), prec)
  const timeLabel = (t) => (t >= now - 60 ? W.now : W.ago[range.key])
  let h = '<div class="mv" data-pair="' + esc(ctx.base + '/' + ctx.quote) + '">'
  // The head: the pair, its last price and change.
  h += '<div class="mv-head"><div><div class="mv-pair">' + esc(bt) + ' / ' + esc(qt) + '</div>'
  if (day.last != null) {
    h += '<div class="mv-last"><span class="mv-num" id="mvLast">' + esc(fmtPrice(day.last)) + '</span> <span class="sub">' + esc(qt) + '</span>'
    if (day.inDay) {
      const c = day.changePct, cls = c >= 0 ? 'mv-up' : 'mv-down'
      h += ' <span class="' + cls + '" id="mvChange">' + (c >= 0 ? '+' : '') + c.toFixed(2) + '%</span> <span class="sub">' + esc(W.change24) + '</span>'
    }
    h += '</div>'
  }
  h += '</div><div class="mv-ranges" role="tablist">' + RANGES.map((r) => '<button type="button" class="mv-range' + (r.key === range.key ? ' on' : '') + '" data-range="' + r.key + '">' + esc(W.ranges[r.key]) + '</button>').join('') + '</div></div>'
  // The day, or that there was none.
  if (!trades.length) h += '<div class="sub mv-note" id="mvNote">' + esc(W.noTrades) + '</div>'
  else if (!day.inDay) h += '<div class="sub mv-note" id="mvNote">' + esc(W.noDay) + ' · ' + esc(W.lastTrade(fmtPrice(day.last) + ' ' + qt, agoText(day.lastT, now))) + '</div>'
  else h += '<div class="sub mv-day">' + esc(W.high) + ' <span class="mv-num">' + esc(fmtPrice(day.hi)) + '</span> · ' + esc(W.low) + ' <span class="mv-num">' + esc(fmtPrice(day.lo)) + '</span> · ' + esc(W.volume) + ' <span class="mv-num">' + esc(amt(day.vol, bp)) + '</span> ' + esc(bt) + '</div>'
  // The chart.
  if (series.pts.length) h += '<div class="mv-chartbox">' + chartSvg(series, { fmt: fmtPrice, timeLabel, label: bt + ' / ' + qt }) + (series.inRange ? '' : '<div class="sub mv-note">' + esc(W.noRange) + '</div>') + '</div>'
  // The book: best bid and ask, and a depth bar.
  if (book.bid != null || book.ask != null) {
    const tot = book.bidDepth + book.askDepth
    const bpct = tot > 0 ? Math.round(book.bidDepth / tot * 100) : 50
    h += '<div class="mv-book"><span>' + esc(W.bid) + ' <span class="mv-num mv-up" id="mvBid">' + esc(book.bid != null ? fmtPrice(book.bid) : '-') + '</span></span>'
      + '<span>' + esc(W.ask) + ' <span class="mv-num mv-down" id="mvAsk">' + esc(book.ask != null ? fmtPrice(book.ask) : '-') + '</span></span></div>'
      + '<div class="mv-depth" title="' + esc(W.buyers + ' ' + bpct + '% · ' + W.sellers + ' ' + (100 - bpct) + '%') + '"><div class="mv-depth-b" style="width:' + bpct + '%"></div><div class="mv-depth-s" style="width:' + (100 - bpct) + '%"></div></div>'
      + '<div class="sub mv-depth-l"><span>' + esc(W.buyers) + ' ' + bpct + '%</span><span>' + esc(W.sellers) + ' ' + (100 - bpct) + '%</span></div>'
  } else h += '<div class="sub mv-note">' + esc(W.noBook) + '</div>'
  if (ctx.dev) {
    const rails = Object.entries(book.byRail)
    if (rails.length) {
      h += '<div class="mv-sec"><div class="lbl">' + esc(MARKET_DEV_WORDS.bookByRail) + '</div>' + rails.map(([r, v]) => '<div class="mv-row"><span>' + esc(RAIL_NAMES[r] || r) + '</span><span class="mv-num mv-up">' + v.bids + ' · ' + esc(fmtPrice(v.bidDepth)) + '</span><span class="mv-num mv-down">' + v.asks + ' · ' + esc(fmtPrice(v.askDepth)) + '</span></div>').join('') + '</div>'
    }
  }
  // Recent trades, newest first.
  if (trades.length) {
    h += '<div class="mv-sec"><div class="lbl">' + esc(W.trades) + '</div><div class="mv-row mv-th sub"><span>' + esc(W.price) + ' (' + esc(qt) + ')</span><span>' + esc(W.amount) + ' (' + esc(bt) + ')</span>' + (ctx.dev ? '<span>' + esc(MARKET_DEV_WORDS.rail) + '</span>' : '') + '<span>' + esc(W.time) + '</span></div>'
    h += trades.slice(-12).reverse().map((t) => '<div class="mv-row mv-trade" data-id="' + esc(t.id || '') + '"' + (ctx.dev ? ' data-rail="' + esc(t.rail || '') + '"' : '') + '><span class="mv-num ' + (t.side === 'sell' ? 'mv-down' : 'mv-up') + '">' + esc(fmtPrice(t.p)) + '</span><span class="mv-num">' + esc(amt(t.size, bp)) + '</span>'
      + (ctx.dev ? '<span class="sub">' + esc(RAIL_NAMES[t.rail] || t.rail || '-') + '</span>' : '') + '<span class="sub">' + esc(agoText(t.ts, now)) + '</span></div>').join('')
    h += '</div>'
  }
  return h + '</div>'
}

// Mounts the view in host and keeps it current while host is on the page. ctx: marketHtml's, plus
// relay() -> the relay's base URL, pair() -> {base, quote} or null, everyMs (default 5000).
export function mountMarketView (host, ctx) {
  let rangeKey = RANGES[0].key, timer = null, req = 0, stopped = false
  async function paint () {
    const p = ctx.pair()
    if (!p || !p.base || !p.quote || p.base === p.quote) { host.innerHTML = ''; return }
    const mine = ++req
    const m = await readMarket(ctx.relay(), p.base, p.quote, rangeKey)
    if (mine !== req || stopped) return
    host.innerHTML = marketHtml(m, { ...ctx, base: p.base, quote: p.quote, rangeKey, now: Math.floor(Date.now() / 1000) })
    for (const b of host.querySelectorAll('.mv-range')) b.onclick = () => { rangeKey = b.dataset.range; paint() }
  }
  function loop () {
    clearTimeout(timer)
    if (stopped || !host.isConnected) return
    if (!ctx.visible || ctx.visible()) paint().catch((e) => console.warn('[market]', e && e.message))
    timer = setTimeout(loop, ctx.everyMs || 5000)
  }
  loop()
  return { refresh: () => paint(), stop: () => { stopped = true; clearTimeout(timer) } }
}
