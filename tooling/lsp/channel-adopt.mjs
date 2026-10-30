// Which channel a "Move to Lightning" (POST /channel/open) may take as its own instead of funding
// one.
//
// A retry of a move whose funding already went out (the wallet's resume after an interruption, a
// plain retry, the service restarting mid-open) must not fund a second channel: the deposit is
// already in the first. Such a retry finds the node holding no deposit, and a channel still
// opening, which that funding started: it adopts that channel.
//
// It never adopts a channel that is already open, and it adopts none while the node holds a
// deposit of at least the amount asked for: then the user has sent a new deposit (a second move,
// or one finishing what an earlier move left on the node), and it funds a new channel. Adopting
// the open channel reported the move "active" while the deposit stayed on the node's own address.
// And only a channel this node opened: one the service opened toward it (room to receive) holds
// none of the user's coins.
export const OPENING_STATES = Object.freeze(['OPENINGD', 'DUALOPEND_OPEN_INIT', 'DUALOPEND_OPEN_COMMITTED',
  'DUALOPEND_OPEN_COMMIT_READY', 'DUALOPEND_AWAITING_LOCKIN', 'CHANNELD_AWAITING_LOCKIN']);

// channels: listpeerchannels' channels with the routing peer. depositWaiting: the node holds, in
// the move's asset, at least the amount asked for. Returns the channel to adopt, or null to fund.
export function adoptableChannel(channels, { depositWaiting = false } = {}) {
  if (depositWaiting) return null;
  return (channels || []).find((c) => OPENING_STATES.includes(c.state) && c.opener !== 'remote') || null;
}
