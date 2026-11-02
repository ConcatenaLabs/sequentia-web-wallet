// A chain that went back below what a wallet already applied.
//
// SWK applies a scan's update only at or above the height the wallet last saw: an update below it
// is refused ("Update height 195096 too old (internal height 195114)"). That happens when the
// blocks the wallet saw left the chain: on Sequentia, when the Bitcoin block they were anchored to
// left testnet4 and every block anchored to it became invalid. Nothing the wallet holds can then
// be built on; the page drops its state and its scan cache and scans again from empty
// (index.html's rebuildAfterReorg). No DOM, so the rule is tested on its own.

// Whether an error is SWK's refusal of an update below the wallet's height.
export function isStaleTipError (e) {
  const m = String((e && e.message) || e || '')
  return /update height \d+ too old \(internal height \d+\)/i.test(m)
}
