// INSTANT PAYMENTS between two wallets of the same operator, in either mode.
//
// A wallet that joined an operator holds a channel leaf in each asset the operator makes
// channels of (the leaf library's `care` with `channels` opens one in the next round, half
// of the wallet's leaves of that asset in it). A payment from one channel into another is
// final for the receiver at once, with no round between. The payer finds the receiver's
// channel in a payment code: the library's `channel_code`, a text naming the receiver's
// channels by asset and one of its addresses. The Receive tab offers the code beside the
// address; the Send tab takes either.
//
// A payment to a code goes over the channels when the payer holds a channel in the asset,
// final and holding the amount, and the code names one of the receiver's in it; the
// library's `send` makes it and refuses it with nothing standing when the receiver's
// channel cannot take it. Otherwise, and after such a refusal, it is paid on the chain to
// the code's address, exactly as a payment to that address, with its own review. Nothing
// is paid twice: a state the operator did not answer stands (the library sends it again at
// its next read of the channel), and the page does not pay that payment another way.
//
// The payer relies on the operator for the one request a channel payment is: the operator
// could co-sign the payer's new state and withhold the receiver's credit. Developer mode
// says so beside the channels.
//
// Pure; tested in instant-pay.test.mjs. Nothing here decides what the library decides: it
// reads the library's answers to choose which way to ask.

// How often an open page reads its channels from the operator while it is visible: a
// payment into one is shown within this.
export const CHANNEL_POLL_MS = 700

export const CODE_KIND = 'channel-code'

// A payment code (the library's text: a prefix word, a colon, the hex of its JSON, kind
// `channel-code`), or null for any other text.
export function readCode (text) {
  const s = String(text || '').trim()
  const i = s.indexOf(':')
  if (i <= 0) return null
  if (!/^[A-Za-z0-9-]+$/.test(s.slice(0, i))) return null
  const hex = s.slice(i + 1)
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) return null
  let v
  try {
    const bytes = new Uint8Array(hex.length / 2)
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16)
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { return null }
  if (!v || typeof v !== 'object' || v.kind !== CODE_KIND || !v.channels || typeof v.channels !== 'object') return null
  return v
}

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// Whether a payment of `atoms` of `asset` to `code` goes over the channels, from the
// wallet's own channel list (the library's `channels`): { instant, why, from, to }.
export function instantRoute (code, asset, atoms, channels) {
  if (!code) return { instant: false, why: 'not a payment code' }
  const a = String(asset || '').toLowerCase()
  const to = code.channels[a]
  if (!to) return { instant: false, why: 'the receiver takes no instant payment in this asset' }
  const mine = (channels || []).filter((c) => c && c.asset === a && c.coin_state === 'live' && c.final === true && !c.pending)
    .sort((x, y) => (big(y.balance) > big(x.balance) ? 1 : -1))[0]
  if (!mine) return { instant: false, why: 'this wallet holds no channel in this asset that can pay now' }
  if (mine.leaf_id === to) return { instant: false, why: 'the code is this wallet’s own' }
  if (big(mine.balance) < big(atoms)) return { instant: false, why: 'this wallet’s channel in this asset holds less than the amount' }
  return { instant: true, why: null, from: mine.leaf_id, to }
}

// What each live channel holds, by asset (the library's `balance` of a channel: its side
// and its credit not folded, as far as the chain pays it).
export function channelTotals (channels) {
  const m = new Map()
  for (const c of channels || []) {
    if (!c || c.coin_state !== 'live' || c.error) continue
    m.set(c.asset, (m.get(c.asset) || 0n) + big(c.balance))
  }
  return m
}

// The credit a channel read brought in: each channel whose credit grew, and by how much.
export function arrivals (before, after) {
  const was = new Map((before || []).filter((c) => c && !c.error).map((c) => [c.leaf_id, big(c.credit)]))
  const out = []
  for (const c of after || []) {
    if (!c || c.error || !was.has(c.leaf_id)) continue
    const d = big(c.credit) - was.get(c.leaf_id)
    if (d > 0n) out.push({ leaf_id: c.leaf_id, asset: c.asset, atoms: d })
  }
  return out
}

// Whether the library's refusal of a payment to a code leaves the payment to be made
// another way (nothing stands) or not (a state was sent and not answered, and stands).
export function fallsBack (error) {
  if (!error) return false
  return error.kind !== 'unreachable'
}
