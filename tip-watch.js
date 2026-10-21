// Keeps the wallet up to date while its page is open: it reads the tip of each chain, and
// asks for a sync when either has moved since the last look. A payment someone sends this
// wallet then shows within a block of arriving, without the user pressing Refresh, and a
// coin another client of the same keys spent (the leaf wallet's board, another device)
// stops counting as soon as the spend is in a block.
//
// Two small requests per look, and a scan only when a block arrived. Nothing is read
// while the page is hidden; on becoming visible again it looks at once.

// Whether the tips read now differ from the last ones. A tip that could not be read (null)
// is no news, and the first look only records where the chains stand.
export function tipsMoved (last, now) {
  if (!last) return false
  return Object.keys(now).some((k) => now[k] != null && last[k] != null && now[k] !== last[k])
}

// Keeps the last known value of each tip that was read.
export function mergeTips (last, now) {
  const out = { ...(last || {}) }
  for (const [k, v] of Object.entries(now)) if (v != null) out[k] = v
  return out
}

// readTips(): { seq, btc } heights (null when unreadable). onMove(): the sync.
// visible(): whether the page can be seen. Answers stop().
export function watchTips ({ readTips, onMove, visible = () => true, everyMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout, onVisible }) {
  let last = null, timer = null, stopped = false, busy = false
  async function look () {
    if (stopped || busy || !visible()) return
    busy = true
    try {
      const now = await readTips()
      const moved = tipsMoved(last, now)
      last = mergeTips(last, now)
      if (moved) await onMove()
    } catch {} finally { busy = false }
  }
  function loop () {
    if (stopped) return
    timer = setTimer(async () => { await look(); loop() }, everyMs)
  }
  loop()
  if (onVisible) onVisible(() => { look() })
  look()
  return { stop () { stopped = true; if (timer != null) clearTimer(timer) }, look }
}
