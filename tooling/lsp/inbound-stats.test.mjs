// The public books of the room-to-receive service: stock, room locked in sold channels, fees,
// demand turned away. Aggregates only.
//
//   node --test tooling/lsp/inbound-stats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildInboundStats, lockedByAsset, summarizeSales, summarizeRefused, stockStatus, refOf, priceList } from './inbound-stats.mjs';

const USDX = '2a'.repeat(32), GOLD = '3a'.repeat(32), TSEQ = 'c8'.repeat(32);
const RATES = { USDX: 1e8, GOLD: 4155e8, bitcoin: 0.37e8 };   // reference atoms per whole unit × 1e8 / 1e8
const label = (a) => ({ [USDX]: 'USDX', [GOLD]: 'GOLD', [TSEQ]: 'tSEQ' })[a] || null;
const NOW = Date.parse('2026-10-20T12:00:00Z'), DAY = 86_400_000;
const CFG = { headroomBps: 1500, reserve: 5000, minRef: 10, maxRef: 10000, floorRef: 1, lowRef: 1000, months: [1, 3, 6, 12], annualBps: 100 };

test('reference values use the fee exchange rate', () => {
  assert.equal(refOf(2e8, 1e8), 2);           // 2 USDX at $1
  assert.equal(refOf(1e7, 4155e8), 415.5);    // 0.1 GOLD
  assert.equal(refOf(5, null), null);
});

test('the status of a stock: out under the smallest sale, low under the threshold', () => {
  assert.equal(stockStatus(1.8, CFG), 'out');
  assert.equal(stockStatus(279, CFG), 'low');
  assert.equal(stockStatus(5000, CFG), 'ok');
  assert.equal(stockStatus(null, CFG), 'unpriced');
});

test('locked room is the LP side of the channels it opened, not closing', () => {
  const pc = { channels: [
    { opener: 'local', state: 'CHANNELD_NORMAL', channel_asset: USDX, to_us_msat: 9e7 * 1000 },
    { opener: 'local', state: 'CHANNELD_AWAITING_LOCKIN', asset: USDX.toUpperCase(), to_us_msat: 1e7 * 1000 },
    { opener: 'remote', state: 'CHANNELD_NORMAL', channel_asset: USDX, to_us_msat: 5e8 * 1000 },
    { opener: 'local', state: 'CLOSINGD_SIGEXCHANGE', channel_asset: USDX, to_us_msat: 5e8 * 1000 },
    { opener: 'local', state: 'CHANNELD_NORMAL', to_us_msat: 70e8 * 1000 },
  ] };
  assert.deepEqual(lockedByAsset(pc, TSEQ), { [USDX]: { atoms: 1e8, channels: 2 }, [TSEQ]: { atoms: 70e8, channels: 1 } });
});

test('sales are summed at the price of their day, refusals over a week', () => {
  const sales = [
    { at: NOW - 2 * DAY, asset: USDX, room: 500e8, months: 1, fee: 1e8, rate: 1e8, expires_at: NOW + 20 * DAY },
    { at: NOW - 40 * DAY, asset: USDX, room: 100e8, months: 12, fee: 1e8, rate: 1e8, expires_at: NOW + 300 * DAY },
  ];
  const s = summarizeSales(sales, NOW);
  assert.equal(s.by[USDX].purchases, 2);
  assert.equal(s.by[USDX].fee_ref, 2);
  assert.equal(s.by[USDX].fee_ref_30d, 1);
  assert.equal(s.by[USDX].expiring_30d, 1);
  assert.equal(s.fees_by_day.length, 30);
  assert.equal(s.fees_by_day.reduce((t, d) => t + d.fee_ref, 0), 1);
  const r = summarizeRefused([{ at: NOW - DAY, asset: USDX, room: 500e8, rate: 1e8 }, { at: NOW - 8 * DAY, asset: USDX, room: 1e8, rate: 1e8 }], NOW);
  assert.deepEqual(r[USDX], { refused: 1, room_atoms: 500e8, room_ref: 500, largest_ref: 500 });
});

test('the price list shows the floor setting the price of small and short rooms', () => {
  const pl = priceList({ rooms: [10, 1000], months: [1, 12], annualBps: 100, floorRef: 1 });
  assert.equal(pl[0].by_months[0].fee_ref, 1);
  assert.ok(Math.abs(pl[0].by_months[0].yearly_yield - 1.2) < 1e-9);   // $1 for $10 for a month: 120% a year
  assert.ok(Math.abs(pl[1].by_months[1].fee_ref - 10) < 1e-9);         // $1000 for 12 months: 1%
});

test('the whole answer: stock, sellable, locked, and nothing that names a node or channel', () => {
  const listfunds = { outputs: [
    { status: 'confirmed', asset: USDX, amount_msat: 2.1e8 * 1000, txid: 'aa'.repeat(32), address: 'tb1qsecret' },
    { status: 'confirmed', asset: GOLD, amount_msat: 0.0773e8 * 1000 },
    { status: 'confirmed', amount_msat: 50000e8 * 1000 },
  ] };
  const peerchannels = { channels: [{ opener: 'local', state: 'CHANNELD_NORMAL', channel_asset: USDX, to_us_msat: 0.9e8 * 1000, peer_id: '02bb'.repeat(16), short_channel_id: '1x2x3' }] };
  const st = buildInboundStats({ listfunds, peerchannels, rates: RATES, label, policyHex: TSEQ, debts: { [USDX]: 1000 }, now: NOW,
    sales: [{ at: NOW - DAY, asset: USDX, room: 0.9e8, months: 1, fee: 1e8, rate: 1e8, expires_at: NOW + 29 * DAY }], refused: [], cfg: CFG });
  const usdx = st.assets.find((a) => a.ticker === 'USDX');
  assert.equal(usdx.status, 'out');                   // 2.1 USDX funds at most ~1.8 of room, under the $10 sale
  assert.ok(usdx.sellable_atoms < usdx.free_atoms);
  assert.equal(usdx.locked_atoms, 0.9e8);
  assert.equal(usdx.channels, 1);
  assert.equal(usdx.expiring_30d, 1);
  assert.equal(st.assets.find((a) => a.ticker === 'tSEQ').status, 'ok');
  assert.equal(st.assets.find((a) => a.ticker === 'GOLD').status, 'low');
  assert.equal(st.totals.purchases, 1);
  const json = JSON.stringify(st);
  for (const leak of ['tb1qsecret', 'aa'.repeat(32), '02bb02bb', '1x2x3']) assert.ok(!json.includes(leak), leak);
});

test('the endpoint is public, read-only, and placed before the token check', () => {
  const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8');
  const route = src.indexOf("url.pathname === '/stats/inbound'"), auth = src.indexOf("if (!authed(req)) return send(res, 401");
  assert.ok(route > 0 && route < auth);
  const post = src.slice(src.indexOf("req.method === 'POST' && url.pathname === '/channel/inbound'"));
  assert.ok(post.indexOf('appendLine(SALES_FILE') > post.indexOf('provisionInbound('), 'a sale is logged only once the channel exists');
  assert.match(post, /if \(!r\.already_had_inbound\) appendLine\(SALES_FILE/);
});
