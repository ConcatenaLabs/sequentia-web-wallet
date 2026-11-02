# sequentia-web-wallet

A non-custodial dual-chain browser wallet for Sequentia testnet and Bitcoin testnet4. One 12-word
phrase, the same `tb1...` address on both chains.

**It is a static page with no build step.** `index.html` loads vanilla ES modules directly. There
is no `package.json`, no bundler, no framework, no CI, and no runtime dependency that is not a
vendored single file. Keep it that way — that constraint is deliberate and is what makes the
wallet auditable by reading it.

Node and consensus conventions live in the
[`Sequentia`](https://github.com/ConcatenaLabs/Sequentia) repo.

## Run and test

The one thing that must be built is `pkg/`, the `lwk_wasm` bindings from
[`SWK`](https://github.com/ConcatenaLabs/SWK). It is untracked and symlinked or
copied in:

```sh
git clone -b sequentia https://github.com/ConcatenaLabs/SWK.git
cd SWK/lwk_wasm
./build-web.sh      # wasm-pack build --target web --release, build paths remapped
cd -
ln -s ../SWK/lwk_wasm/pkg ./pkg
```

`index.html` imports a default-exported `init` from `./pkg/lwk_wasm.js`, which only the
`--target web` build produces.

```sh
python3 -m http.server 8080     # then open http://127.0.0.1:8080/
node --test                     # the node:test suites
```

The tests are the `*.test.mjs` files at the root and under `tooling/lsp/`, and `node --test` runs
every one of them. Some are **standalone scripts** with their own `check()` harness: `node --test`
runs each as one test, and each also runs on its own (`node covenant-byteorder.test.mjs`).

Anything importing `swap.js` from Node needs a `localStorage` shim installed before the import;
`swap.js` reads it at module load. Existing tests show the idiom.

`lightning/pkg/` is a *different* wasm artifact (the SeqLN on-device signer) and **is** tracked.
Do not confuse it with `pkg/`. So is `leaves/pkg/`, the leaf wallet of developer mode: the
operator wallet library (`bark::arca` in `ConcatenaLabs/arca`), built from that repository's
`wallet-wasm/`. **What is committed is always that repository's CI build, copied exactly:** the
`leaf-wallet-pkg` artifact of a commit on its master, fetched by `tooling/fetch-leaf-wallet.sh
<arca commit>` with its `BUILT_FROM` (the commit) and `SHA256SUMS`, so the wasm a release serves
is traced by its sha256 to one arca commit; `leaf-pkg-built-from.test.mjs` checks the files
against those sums. Never commit a local build. `tooling/build-leaf-wallet.sh <arca checkout>`
builds one for trying an unmerged arca change on this machine (every build-machine path remapped
out of the wasm, as CI does). The Ambra browser extension vendors the same files. It runs only
inside `leaves/worker.js`, a dedicated worker, because the library blocks on synchronous
requests and keeps its SQLite store on OPFS. Nothing about a leaf is computed in JavaScript:
`leaves.js` shows what the library answers, refusals in the library's own words, and nothing
in it may decide anything the library decides. The page's copy never names the operator
protocol: developer mode speaks of leaves, rounds and the operator.

`lightning-to-ark.js` is default mode's move of what a wallet's own hosted Lightning channels
hold (a wallet made before default mode held its coins in the Ark): the BTC channel pays an
invoice of the wallet's own Bitcoin ark, each asset channel a `lightning_receive` of its leaf
wallet, only from a channel locked in, within the page's Lightning payment limit, never in
developer mode or while a person uses the wallet; the figure holds it under "Moving …" meanwhile,
and an emptied channel is closed to the wallet's address when cheap and safe. It has no DOM
(`lightning-to-ark.test.mjs`); `index.html`'s `initLnToArk` gives it the page, and the extension
copies it into its `vendor/` with its own host: change it here first. Ambra mobile's
`lightning_to_ark.dart` is the same move in the same words.

`asset-lightning.js` is default mode's rule for an asset sent to a receive code of another
operator: over Lightning, out of the tree (`lightning_pay_quote`, then `lightning_pay` with the
quote as `shown`), when the code carries an invoice in the asset for the amount (a receive code
with an amount in an asset carries one, from the leaf library's `lightning_receive`), the payment
is worth no more than `window.SEQ_ASSET_LN_MAX_USD` (USD, never units of the asset), the
operator's node can carry it and the invoice's final lock fits the operator's window with a hop
to spare; else the code's address, and the review says why. It has no DOM
(`asset-lightning.test.mjs`). Ambra mobile and the browser extension route receive codes in
their own code: give them the same rule.

`btc-ark/pkg/` is tracked too: Bark's wallet for Bitcoin arks, built from arca's `bark-wasm/` by
`tooling/build-btc-ark.sh <arca checkout>` (paths remapped the same way), run inside
`btc-ark/worker.js`. It holds default mode's BTC on the Bitcoin ark named by `SEQ_BTC_ARK`: native
bitcoin, never pegged, from the page's own phrase under Bark's key path. `btc-ark.js` names the
route (an invoice, an Ark address, a Bitcoin address) and shows the wallet's answers; every fee,
coin and refusal is the wallet's. A board is cosigned by the ark's server before the page signs
its funding: keep that order. Whenever the ark is open the trade engine's `deps.btc` is the ark
(`btcArk.lightning()`), in both modes, so a BTC trade pays and is paid there and a trade resumed
after the mode changed pays with the wallet it was made with; the payment's lock is bounded by
the server's longest (`max_route_delay`), which the trade checks against the coin it receives.

The mode is kept for each wallet (`swk.mode.<walletTag>`, `leaves.js`), user mode by default,
and its words are the same in the extension and Ambra: change them in all three together. User
mode's words and what it never shows are `docs/DEFAULT_MODE.md`, the contract every Concatena
wallet follows; `default-arca.js` holds the strings and is tested against
`USER_MODE_FORBIDDEN_WORDS`. In user mode a wallet joins the page's operator by itself
(`window.SEQ_ARCA`, its key pinned: the server must show it before `create`, the wallet's `info`
after), restores once, and retries every two minutes when it cannot; Receive gives a receive code,
a payment to a receive code of the same operator and chain goes in the tree (`treeRoute`), and
coins new on the chain are boarded in `leaves.js`'s upkeep (`boardArrivals`: never in developer
mode, never ahead of a person, never within a minute of the page's own on-chain payment, since
both spend the same keys' coins). An address the chain's coins can't cover is paid out of the tree
(`offboard_quote`, then `offboard` with the quote as `shown`). A payment the operator refuses as too
many reassignments from a round (`depth_limit`) refreshes that asset's coins in the next round and
is asked again once it is final (`paying`), as a release is. A wallet joined by itself restores
once to the end (`RESTORED_KEY`; a page closed mid-restore restores at its next open) and counts
as open only after it, so the page works on the chain alone meanwhile. The worker answers one
command at a time, so in user mode on the page's operator the wallet's own work never stands in
a person's way: the pass that syncs at open, care, boards and the mailbox read (every ten seconds,
`watchMailbox`) wait for twenty quiet seconds after the page opens or a person asks anything (a
trade's quote asks the library several times); the bond's watch, which holds the worker for most
of a minute, runs at most hourly after two quiet minutes; and the Trade tab follows a trade older
than two minutes every half minute, and never while a price is asked. A wallet that joined an operator keeps its leaf wallet syncing
in either mode; user mode shows nothing of leaves and the page API refuses every leaf method
there, but leaves count in each asset's figure and the headline. Each asset's figure counts
on-chain, leaves, Lightning and, for tSEQ, what is staked (`stakedAtoms` in `index.html`), in
both modes; user mode shows that one figure, what is arriving, and no rail, Move or room to
receive. After a sync, at most every ten minutes, `leaves.js` runs the library's `care` (claims taken up,
a leaf of a round planned once its first step could run within the library's ten-day reach, a
plan whose leaf moved cancelled) in either mode, with `claimScan` from the page (the kit's next
receive index and 20 more); developer mode lists plans with Cancel and Release (`plan_release`). After
each care, and at most every two minutes besides, it reads the library's `claims` (only it gives a
vesting claim's asset and value) and keeps what vests later for the wallet (`vestingLots` in
`default-arca.js`): part of the asset's figure and the headline in both modes, one line per date
under the figure, never in what can be spent, so no Max counts it, and Send, Trade, Stake and Mix
refuse an amount that needs it (`refuseIfVesting` in `index.html`, the engine's `vesting`). Every leaf
command a person or a page starts goes through `paying` in `leaves.js` (the API's `command` and
`pay`, the user composer's commands included): a refusal of kind `planned` releases the leaves
it names, waits for their round, and asks again. Keep that one path. `wallet-api.js` is the page API (`docs/PAGE_API.md`); it
answers as the extension's provider answers, and `leaf-request.js` is copied into the
extension's `src/`: change it here first.

`leaf-rail.js` is developer mode's Leaf choice in the Trade tab and its panel. The same rule
holds there: what a choice settles as is the settlement router's (`settlement-router.mjs`), which
offers a leaf can take is the unified book's (`caps.leaf_take`), and every amount, fee and
refusal is the leaf wallet's. Its seams into `swap.js` are small on purpose (the rail painter
skips the Leaf buttons, `autoRails` never overrides a Leaf choice, `onReview` never runs on a Leaf
leg, `updateRails` repaints it); keep them that way rather than routing a leaf through the
on-chain or Lightning paths, which would settle it as something it is not. The leaf library reads
an order as the relay serves it (byte fields in base64), so the panel hands it the relay's own
JSON, never the copy `normRelayOffer` rewrote to hex.

`ark-rail.js` is developer mode's Ark choice on the BTC side of a pair of BTC and a Sequentia
asset. It settles as user mode's BTC trade does (the user composer's engine, `user-trade.js`, with
the ark as `deps.btc`): a market trade, the asset's side on Leaf (choosing Ark sets it), every
amount and refusal the engine's. Its seams into `swap.js` are the leaf rail's (`paneRail` covers
both), and `leaf-rail.js` offers Leaf in a pair with BTC only while BTC's side is on Ark, leaving
that trade to the Ark panel.

`contracts.js` is developer mode's Contracts tab. The same rule holds: the kit's contract engine
(`ContractTemplate`, `ContractInstance`, `ContractSpend`, `ContractApproval` in `pkg/`) reads,
checks, builds, runs and signs; the module renders the approval it returns and signs the
digest of what it rendered. Never compute an amount, a script or a verdict about a contract in
JavaScript. The browser extension copies this file into its `vendor/`; change it here first.

## The shape of the code

Root is flat: production modules and tests sit side by side.

- `index.html` — the wallet core: boot, balances, send/receive, fees, staking, history, OpenAMP, QR.
- `instant-history.js` — History's rows for what is paid and received in seconds and for the Trade
  tab's trades: a per-wallet log the page writes as payments happen (`leafArrived`, `payCode`,
  `offboard`), merged with the composer's own trade records, never copied from them.
- `stake-records.js` — joining, moving and leaving a staking pool, and unbonding: every
  transaction over a bare script of the staking key, built and signed by SWK for the height of the
  block it enters. It refuses to sign without a chain tip, because the signature a stake record
  spend needs changes at the chain's `pos_records_v2_height`. A join is two transactions (the
  wallet pays its own staking key, the record spends that coin), persisted before either is
  broadcast. It finds and unbonds stakes under both locks a Sequentia wallet bonds with
  (`STAKE_CSVS`: the height lock this page uses and the time lock Ambra uses).
  `tooling/stake-records-regtest.mjs` runs it against a real node.
- `swap.js` — the Trade tab core and by far the largest file: the symmetric Pay/Receive composer.
  Routing is derived from the chosen assets. It imports the rail modules (`seqob.js`, `btc.js`,
  `covenant*.js`, `ln-rail.js`, `seqln.js`, `submarine.js`, `sbtc.js`, `subswap.js`) and three
  files from `tooling/lsp/`.
- `user-trade.js` and `user-composer.js` — the Trade tab in user mode: three inputs and one
  button, a market trade in one native step from the single-step book
  (`tooling/lsp/single-step-book.mjs`: an in-tree swap with a live leaf maker, a transparent
  covenant order taken in the operator's round, an order resting in the operator's tree
  (`order_fill_resting`), or BTC for an asset in one hash-lock with a
  maker's BTC desk, `user-trade-btc.js`), never a bridge and never a second route. In a BTC trade
  the hash is always the BTC receiver's and BTC is paid only once the coin received under it is
  held for good (`lightning_receive_ready`); keep that order whatever else changes. On the page
  the wallet's Bitcoin Lightning is `btc-lightning.js` over its own hosted Bitcoin node: a sale's
  hold is under a hash whose preimage the page draws and keeps, and the page gives it to the node
  only to settle a payment held there for the whole amount; never let the node make that
  preimage or learn it first, or the service hosting it could hand it to the maker. The
  engine (`user-trade.js`) has no DOM so the drill runs it in Node; every amount on its ticket is
  the leaf library's answer (`swap_read`, `take_quote` with `spends`, `settle_quote`). Every word
  it shows is in `USER_WORDS`, and none may be in `USER_MODE_FORBIDDEN_WORDS` (rail, round, leaf,
  operator, covenant, expiry, atom and the rest): its test checks both. A pair reaches user mode
  only through `user-mode/pairs.json`, which only a passing drill run
  (`tooling/user-mode-drill.mjs`) may extend. Developer mode's composer is untouched by it. **The Trade tab follows the mode,
  by the repository owner's decision ("Simple composer in default mode, full composer in dev
  mode")**: the user composer when developer mode is off, the full composer when it is on,
  switching with the mode (`applyTradeMode` in `index.html`). A page that sets
  `window.SEQ_USER_TRADE = false` keeps the full composer in both modes. `user-trade-switch.test.mjs`
  holds the rule both ways; change it only when the owner asks for it.
- `xswap.js`, `xrswap.js`, `xcourier.js`, `xmaker.js` — the cross-chain courier path. **These are
  live.** The RFQ client that used to sit alongside them was retired; the `xchain`/`xswap` naming
  survives on code that is very much in use. Do not delete them on the assumption they are dead
  RFQ leftovers.
- `tooling/lsp/` — the hosted-SeqLN LSP backend and its provisioning harnesses. Mostly Node-only,
  **but `settlement-router.mjs`, `unified-book.mjs`, `single-step-book.mjs` and `bridge-driver.mjs`
  are imported into the browser** (by `swap.js` and `user-trade.js`). They contain no `require`, no `node:` imports and no `process.` access by
  construction. Adding any of those to those four files breaks the shipped page.
- `coinjoin.js` — the Mix tab's wallet side: coin selection, ownership proofs, blinded addresses and,
  above all, `verifyRoundOutputs`, the check that decides whether to sign a transaction the
  coordinator built. `blindsig.js` and `coinjoin-protocol.js` beside it are **vendored from the
  [`seqcj`](https://github.com/ConcatenaLabs/seqcj) repo** and must stay byte-identical
  to their originals apart from the header and import path — the point of vendoring rather than
  reimplementing is that the protocol proven by seqcj's end-to-end test is the protocol this wallet
  runs. Signing and unblinding go through `coinjoinSignInputs` / `coinjoinUnblindOutputs` in wasm.
- `btc.js`, `jsqr.js`, `noble-ciphers.js` — vendored libraries, checked in as single files. Do not
  edit them.
- Modules expose an `export const __test__ = { ... }` hook for tests rather than exporting internals.

## Byte order at the covenant boundary

This is the single sharpest trap in the repo, and it has produced live bugs twice.

The wallet, UI, registry and relay-pair domain speak **display** hex asset ids (reversed, like
txids). The covenant leaf, `CovenantTerms`, and on-chain introspection speak **internal** order.
The relay convention is: `pair` is display, `terms` is internal.

- Persisted records store **display** ids in both generations.
- `offer.pair` / `offer_asset` / `want_asset` are **display**.
- `CovenantTerms.asset_a`/`asset_b` and the tapscript fill leaf are **internal**.
- `covenantDerivationIds()` in `swap.js` is the one named conversion boundary on the place side.
  Feeding display ids into the derivation produces an spk that the watcher, settler and consensus
  cannot match.
- The fill host seam flips internal to display for coin selection, mirroring the Go settler.
  Leaf, control-block and witness hexes are consensus bytes and are never touched.
- `revHex` exists twice on purpose (`swap.js` for place/refund, `covenant-fill-host.js` for the
  host seam). One test asserts they agree. Nothing else enforces it.

**Records carry an `idsInternal` marker and legacy records are deliberately not migrated.** A
record without the marker keeps the old display-order derivation, because its refund must
re-derive the same taptree. "Fixing" a legacy record strands its locked coins forever.

Byte-order bugs here are cross-language: the counterpart is Go, in `seqdex`. The golden vectors in
`covenant-byteorder.test.mjs` are pinned against the Go side. Keep them pinned. So is the layout
of a transaction filling several orders (order `k` at input `k`, its credit at `2k`, its rest or gap
at `2k+1`): `covenant-fill-vectors.json` is a copy of seqdex's
`daemon/pkg/covenant/testdata/fill_vectors.json`, and `covenant-fills.test.mjs` holds
`buildFillTx` and `checkFill` to its bytes. When the Go side changes the file, copy it here. The
signed bytes of a covenant offer leave its outpoint out, so the relay can re-point a resting order
at `(txid, 2k+1)` after a fill without its offline maker signing again: `covenant-offer-vectors.json`
(a copy of seqdex's `daemon/internal/seqob/offer/testdata/covenant_offer_vectors.json`) holds Go's
canonical bytes and signature for an offer served at its funding outpoint and again after a move,
and `covenant-offer-move.test.mjs` verifies both through `normRelayOffer` and `verifyOffer`.
The Simplicity order of the template `seqdex/order` (`covenant-sim.js`: its address from the terms
and the pinned commitment root, and a fill's witness from the template's pinned programs, no
compiler) has two versions, each with its own root: version 2, which every new order uses and
which refuses an annex, and version 1, kept for the orders resting under it. An order's
`template_hash` names its version. Version 2 is held to `seqdex-order-2-vectors.json` and
`seqdex-order-2-fills.json`, copies of seqdex's `daemon/pkg/covenant/seqdex_order_2/`
`vectors.json` and `fills.json`, version 1 to `seqdex-order-vectors.json` and
`seqdex-order-fills.json`, copies of `daemon/pkg/covenant/seqdex_order/`'s; its offer member
(`simplicity_covenant`, field 25) to `simplicity-offer-vectors.json`, a copy of seqdex's
`daemon/internal/seqob/offer/testdata/simplicity_offer_vectors.json`, by `covenant-sim.test.mjs`.
When seqdex re-pins a version, copy its files here. An order resting as a leaf in an operator's
tree (`resting_leaf`, field 26) signs its terms, operator and order id and leaves its locator (the
coin it rests at, what that coin holds) out: `resting-offer-vectors.json`, a copy of seqdex's
`daemon/internal/seqob/offer/testdata/resting_leaf_offer_vectors.json`, holds
`resting-offer.test.mjs` to Go's bytes and signature where the order first rests and after a part
fill moved it. An offer's `time_in_force` (field 24) is
signed too, written before the settlement oneof as protobuf-go writes it:
`time-in-force-offer-vectors.json`, a copy of seqdex's
`daemon/internal/seqob/offer/testdata/time_in_force_offer_vectors.json`, holds
`time-in-force-offer.test.mjs` to Go's bytes and signature for each value. The tapscript leaf reads its terms as signed
64-bit numbers, so `buildFillLeaf` refuses a `rate_num`, `rate_den` or `min_lot` of 2^63 or more
(`checkLeafTerms`, as seqdex's Go `CheckTerms`): `covenant-terms-vectors.json`, a copy of seqdex's
`daemon/pkg/covenant/testdata/terms_bound_vectors.json`, holds `covenant-terms.test.mjs` to Go's
leaf bytes below the edge and to the refusal at it.

## Fund-safety idioms that are already established

Match them; do not invent a new pattern.

- **Persist before broadcast.** Every path that broadcasts something reclaimable persists the full
  reclaim material first — refund key, redeem script, secret, locktime, amounts — and only then
  broadcasts, so a crash or tab close in that window leaves recoverable funds rather than stranded
  ones. Where the outpoint is not yet known, the record is written with a null txid and the resume
  pass locates it by scriptPubKey.
- **Never serve key material to a client.** The LSP scrubs job objects before every response,
  dropping anything matching `priv|secret|seed|mnemonic` and any underscore-prefixed internal
  handle. This exists because a polling client once received the key to sweep a fronted HTLC's
  refund branch. Error detail is scrubbed separately (credentials stripped from URLs, absolute
  paths rewritten).
- **The anchor check is the claim gate, and it has three verdicts, not two.** Unconfirmed means
  wait; an asset leg anchored at or below the BTC lock height is **terminally** unsafe, because it
  could outlive the BTC in a reorg. Unknown must be represented as `-1`, never `0` — `0` reads as
  the terminal verdict. There is no auto-advance past this gate.
- **Fail closed.** Missing callbacks throw rather than defaulting; an empty asset stays empty
  rather than matching everything.
- **Review before broadcast.** Sends, issuance, staking and order placement all route through a
  structured review dialog. Never blind-sign.
- **One record per trade, not per rail.** This has been fixed four separate times. State keyed by
  rail means one stuck trade wedges the rail for every other trade.

## Known limitations, stated honestly

The mnemonic is stored in plaintext `localStorage` with no passphrase encryption. The LSP bearer
token is a single shared token configured inline in `index.html`, not a per-user credential. Both
are documented in `README.md` and `docs/ARCHITECTURE.md`. Do not build anything that assumes
otherwise, and do not add further secrets to the page.

`docs/ARCHITECTURE.md` covers the module graph and the protocols at a high level and says little
about the leg bridge; `tooling/lsp/HANDOFF.md` is an explicitly dated point-in-time handoff. Verify
both against code.

## Working in this repo

- **Repository is public.** Never commit seeds, private keys, wallet files, RPC credentials, `.env`
  files or new tokens.
- **Commit author:**
  `GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`
- **Always open a pull request, then merge it yourself immediately.** The PR exists so the change
  and its reasoning are recorded, not because anyone is waiting to review it. There is no review
  process. If you are ever told to leave one specific PR open, that applies to that PR only and
  never becomes the default.
- Development happens on `main`, which is the remote default.
- **Deployment is pull-only.** The server pulls this repo from GitHub and builds there. Never edit
  source on the server and never copy source or binaries onto it.
- `git log` and `git blame` before 2026-06-21 are LWK's Rust history, not this wallet's — the repo
  was split out of SWK and kept its history.

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as the person the session is working for.** Several people
commit in these repositories and an agent always runs on behalf of one of them,
so derive the author from the authenticated GitHub account rather than from a
list of names that goes stale the moment somebody new arrives:

    git -c user.name="$(gh api user --jq '.name // .login')" \
        -c user.email="$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')" \
        commit ...

That address is the GitHub `noreply` form, which is what links a commit to its
account and keeps private addresses out of a public history. When `gh` is not
authenticated as the person the work belongs to, ask them instead of guessing.

**Never infer the author from `git log`.** The clones carry no `user.name` or
`user.email`, so `git commit` stops with "Author identity unknown" and the
nearest answer to hand is the author of the last commit — which is whoever
pushed last and says nothing about who is working now. Attributing a commit to
someone who did not write it puts their name on code they never reviewed, and
taking it back costs a history rewrite and a force-push over commits other
machines have already pulled.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Documentation is part of the change, not a follow-up.** A change that makes a
README, a doc page, a runbook or a code comment wrong is not finished until that
text is right again, in the same pull request as the code. Before you open the
pull request, search the repository for whatever you renamed, moved or removed —
the old binary name, the old path, the old flag, the old command — and fix every
hit. If the change falsifies another repository's documentation, that repository
gets its own pull request in the same sitting. A stale instruction costs a new
user more than a missing one: they trust it, run it, it fails, and the failure
reads as broken software rather than as an out-of-date sentence.

**Write documentation to be timeless.** Assume the reader is new, arrived today,
and wants to know what the software is and how to use it right now. They do not
care what changed, what it used to be called, or which version added what. So
write in the present tense about current behaviour, and leave the history out:
no changelogs, no "new in", no "recently", no "coming soon", no status or
progress sections, no roadmaps, no dated notes. Quote a version number only where
the reader cannot act without it, and prefer pointing at the file that carries it
over copying the digits. Timeless does not mean thin — what the product is, who
it is for, and how to install, configure and use it all still belong there, in
full. Documentation written this way survives a release without an edit, which is
what keeps it true; the history already has homes in the git log, the tags and
the release notes.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
