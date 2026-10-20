// How long a trade that waits on Bitcoin testnet4 takes, said honestly.
//
// Testnet4 is not Bitcoin: its blocks come irregularly, sometimes several in minutes and then none
// for hours, and it is often flooded with transactions. A swap with an on-chain BTC leg waits on
// those blocks, and without a word about it the wait reads as the wallet being broken. Every place
// a trade waits on testnet4 says the same thing, from here, and the Active trades rows add how long
// ago the last testnet4 block was found, which is the one number that explains a long wait.

// For a review or a quote, before anything is committed.
export const T4_WAIT = 'Waits on Bitcoin confirmations, on testnet4: its blocks come irregularly, sometimes hours apart, '
  + 'and it is often flooded: that is the test network, not Sequentia (on Bitcoin itself a block comes about every 10 minutes). '
  + 'Safe to leave: it resumes and refunds automatically.';
// For a quote line, where there is room for a few words.
export const T4_WAIT_SHORT = 'waits on Bitcoin confirmations: testnet4 blocks can be hours apart';

// Seconds since the last testnet4 block, read from the explorer's testnet4 API (`base`, by default
// this origin) at most once a minute. Null when it cannot be read.
let _cache = { at: 0, age: null, tip: null, pending: null };
export async function testnet4BlockAge({ base = '', fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (_cache.tip != null && now - _cache.at < 60_000) return Math.max(0, Math.round((now - _cache.tip) / 1000));
  if (_cache.pending) return _cache.pending;
  _cache.pending = (async () => {
    try {
      const hash = (await (await fetchImpl(base + '/testnet4/api/blocks/tip/hash')).text()).trim();
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const b = await (await fetchImpl(base + '/testnet4/api/block/' + hash)).json();
      const t = Number(b && b.timestamp);
      if (!(t > 0)) return null;
      _cache = { at: now, tip: t * 1000, pending: null };
      return Math.max(0, Math.round((now - t * 1000) / 1000));
    } catch { return null; } finally { _cache.pending = null; }
  })();
  return _cache.pending;
}
// The last age read, without waiting (null before the first read); asks for a fresh one meanwhile.
export function testnet4BlockAgeNow(now = Date.now()) {
  testnet4BlockAge({ now }).catch(() => {});
  return _cache.tip != null ? Math.max(0, Math.round((now - _cache.tip) / 1000)) : null;
}

// "The last testnet4 block was found 1 h 20 min ago." Past 30 minutes it says the network is slow.
export function blockAgeText(sec) {
  if (sec == null || !(sec >= 0)) return '';
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  const ago = m < 1 ? 'less than a minute' : h < 1 ? m + ' min' : h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return 'The last testnet4 block was found ' + ago + ' ago'
    + (m >= 30 ? ': testnet4 is slow right now, so this can take a while longer.' : '.');
}

export const __test__ = { reset: () => { _cache = { at: 0, age: null, tip: null, pending: null }; } };
