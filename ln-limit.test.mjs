import test from 'node:test';
import assert from 'node:assert/strict';
import { lnRatesFor, lnLimitRefusal, LN_DAILY_LIMIT_REFERENCE } from './ln-limit.js';

const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de';
const EURX = 'e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13';

test('the rates are the node\'s, by asset id, and Bitcoin\'s from its price', () => {
  const rates = { [USDX]: 100000000, [EURX]: 112000000 };
  const out = lnRatesFor([USDX, EURX, 'BTC', 'oamp:x', USDX], (h) => rates[h], 60000);
  assert.deepEqual(out, { [USDX]: 100000000, [EURX]: 112000000, btc: 6000000000000 });
});

test('an asset the node does not price gets no rate (the device holds it to its own atoms)', () => {
  assert.deepEqual(lnRatesFor([USDX], () => undefined, null), {});
  assert.deepEqual(lnRatesFor([USDX], () => 0, 0), {});
});

test('a payment over the limit reads in plain words; anything else does not', () => {
  assert.equal(LN_DAILY_LIMIT_REFERENCE, 1000);
  const m = "Your device declined this payment of 100000000 atoms: it is more than your device's payment limit for USDX still allows in this period.";
  assert.equal(lnLimitRefusal(m),
    'This payment is over the daily limit your device sets for Lightning payments (about 1,000 USD a day). Nothing was sent.');
  assert.equal(lnLimitRefusal('pay: no route'), null);
});
