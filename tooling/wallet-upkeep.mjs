// What a wallet left running does by itself, as the page keeps one in user mode (leaves.js): it
// syncs every UPKEEP_SYNC_MS, which refreshes a coin the operator names as all that holds a node
// back (the change of the wallet's own payment among them), and gives up what it received out of
// round in the operator's next round (`refresh_received`) at most every UPKEEP_REFRESH_MS. A coin
// paid to the wallet out of round, and the change of its own payment, rest on the payer's old
// lowest node until they are refreshed: until then the operator's fronted value for that node
// stays out. The page refreshes them; a wallet that only trades never would.
//
//   const u = createUpkeep({ command: (name, args) => w.command(name, args), log })
//   setInterval(() => serial(u.tick), 15_000)   // each tick runs between the wallet's trades
//   u.state                                      // { sync, refresh }: when each last ran, and what it answered
export const UPKEEP_SYNC_MS = 60_000
export const UPKEEP_REFRESH_MS = 120_000

export function createUpkeep ({ command, now = () => Date.now(), log = () => {} }) {
  const state = { sync: null, refresh: null }
  async function tick () {
    const t = now()
    if (!state.sync || t - state.sync.at >= UPKEEP_SYNC_MS) {
      try {
        const v = await command('sync', {})
        const asked = (v && v.refresh) || []
        state.sync = { at: t, refresh: asked.length }
        if (asked.length) log(`[upkeep] sync asked for ${asked.length} refresh(es):`, JSON.stringify(asked.map((r) => ({ leaf_id: r.leaf_id, state: r.state, error: r.error }))))
      } catch (e) { state.sync = { at: t, error: String(e && e.message) }; log('[upkeep] sync:', e && e.message) }
    }
    if (!state.refresh || t - state.refresh.at >= UPKEEP_REFRESH_MS) {
      try {
        const v = await command('refresh_received', {})
        const n = ((v && v.refreshed) || []).length
        state.refresh = { at: t, refreshed: n, left: ((v && v.left) || []).length }
        if (n) log(`[upkeep] ${n} coin(s) received out of round given up in the next round`)
      } catch (e) { state.refresh = { at: t, error: String(e && e.message) }; log('[upkeep] refresh_received:', e && e.message) }
    }
  }
  return { tick, state }
}
