// The page stops asking for what does not exist: the retired RFQ market list is not requested, and
// the old-derivation OpenAMP identity is looked up once per wallet, its absence remembered, instead
// of a 404 in the console at every load.
//   node --test quiet-load.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8')

test('no request for the retired market list', () => {
  assert.ok(!swap.includes("'/v1/markets'") && !/function dexPost/.test(swap))
})

test('the absent legacy identity is asked about once per wallet', async () => {
  const i = html.indexOf("if(OAMP_LEGACY_AID && OAMP_LEGACY_AID!==localAid){"); const block = html.slice(i, html.indexOf('\n    }', i) + 6)
  const store = new Map(); let asked = 0
  const run = new Function('ctx', `return (async () => { let { OAMP_LEGACY_AID, localAid, OPENAMP, fetch, localStorage } = ctx; ${block}; return OAMP_LEGACY_AID })()`)
  const ctx = () => ({ OAMP_LEGACY_AID: 'aa', localAid: 'bb', OPENAMP: '/openamp', fetch: async () => { asked++; return { status: 404 } },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } })
  assert.equal(await run(ctx()), ''); assert.equal(asked, 1); assert.equal(store.get('swk.oamp.legacyAbsent.aa'), '1')
  assert.equal(await run(ctx()), ''); assert.equal(asked, 1, 'the next load does not ask')
  const found = { ...ctx(), OAMP_LEGACY_AID: 'cc', fetch: async () => { asked++; return { status: 200 } } }
  assert.equal(await run(found), 'cc', 'a registered legacy identity is kept'); assert.equal(store.has('swk.oamp.legacyAbsent.cc'), false)
})
