// A swap that pays BTC over Lightning makes its own room to receive: Lightning stays on for a BTC
// receive where the service sells BTC room, the review shows the room's fee in one plain sentence,
// the room is opened only after Confirm and before the trade, and its fee is paid from the BTC
// received. Every refusal offers the one tap that gets the trade through.
//
//   node --test swap-btc-room.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i) + 3); };

test('a BTC receive over Lightning is open where the service sells BTC room, with no room yet', () => {
  assert.match(fn('legRailOptions'), /const room = ln\.recv > 0 \|\| \(hex === 'BTC' && lnOn && btcRoomSold\(\)\);/);
  assert.match(fn('btcRoomSold'), /LNSTATUS\.funding\.btc_room/);
  const note = fn('renderRailNote');
  assert.match(note, /if \(!pick && btcRoomLeg\)\{[^}]*BTC_ROOM_NOTE/);
});

test('the room is quoted before the review, opened after Confirm, and paid for after the settle', () => {
  const r = fn('reviewLn');
  const plan = r.indexOf('btcRoom = await btcRoomPlan(_recvWant);'), sheet = r.indexOf("C.modalRows({ title: 'Review Lightning swap'");
  const open = r.indexOf('await openBtcRoom(btcRoom, _recvWant'), swap = r.indexOf('await L.swap(plnSwapBody(');
  const fee = r.indexOf('payBtcRoomFee(btcRoom.nodeKey)');
  assert.ok(plan > 0 && sheet > plan && open > sheet && swap > open && fee > swap, 'plan < sheet < open < swap < fee');
  assert.match(r, /if \(!made\.ok\)\{\s*modal\.remove\(\); refuseToChain\(made\.why\); return;/, 'a room that does not open stops before the trade');
  assert.doesNotMatch(r, /Your largest BTC Lightning channel can receive/, 'the old dead end is gone');
  assert.match(r, /if \(!ra\.recvLn\.ok && !btcRoom\) await provRecvInbound/, 'a BTC receive never opens outbound room instead');
});

test('default mode reads one plain sentence; the channel and its trust are developer detail', () => {
  const r = fn('reviewLn');
  const row = r.match(/\['Room to receive', `([^`]*)`\]/);
  assert.ok(row, 'the room row');
  assert.doesNotMatch(row[1], /channel|node|confirm|zero|0-conf|sat\b/i);
  assert.match(r, /\[BTC_ROOM_DEV_KEY, `The service opens a [^`]*you trust the service not to double-spend its funding\.`\]/);
  assert.match(r, /d\.classList\.add\('dev-only'\)/);
  assert.doesNotMatch(src.match(/const BTC_ROOM_NOTE = '([^']*)'/)[1], /channel|node/i);
});

test('the plan opens the smallest room sold, refuses a fee as large as the trade, and refusals carry the tap', () => {
  const p = fn('btcRoomPlan');
  assert.match(p, /Number\(want\) < Number\(q\.min\)\) q = await L\.inboundQuote\(\{ asset: 'BTC', amount: Number\(q\.min\)/);
  assert.match(p, /if \(!\(fee < Number\(want\)\)\) return \{ ok: false/);
  const o = fn('openBtcRoom');
  assert.ok(o.indexOf('L.readyBtcNode(') < o.indexOf('L.channelInbound('), 'the node is up before the room opens');
  assert.match(o, /mode: 'deferred'/);
  assert.match(o, /big\(l\.maxReceivable \?\? 0\) >= want/, 'one channel holds the whole payment');
  assert.match(fn('refuseToChain'), /Receive it on-chain<\/button>/);
  const f = fn('payBtcRoomFee');
  assert.ok(f.indexOf('L.inboundSettle({ node_key: nodeKey, asset: \'BTC\' })') < f.indexOf('L.nodePay(') && f.indexOf('L.nodePay(') < f.indexOf('payment_hash: inv.payment_hash'));
});
