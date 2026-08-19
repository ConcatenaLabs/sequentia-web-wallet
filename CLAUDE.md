# sequentia-web-wallet

A non-custodial dual-chain browser wallet for Sequentia testnet and Bitcoin testnet4. One 12-word
phrase, the same `tb1...` address on both chains.

**It is a static page with no build step.** `index.html` loads vanilla ES modules directly. There
is no `package.json`, no bundler, no framework, no CI, and no runtime dependency that is not a
vendored single file. Keep it that way — that constraint is deliberate and is what makes the
wallet auditable by reading it.

Node and consensus conventions live in the
[`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) repo.

## Run and test

The one thing that must be built is `pkg/`, the `lwk_wasm` bindings from
[`SWK`](https://github.com/GracedEternalKingCabbageMan/SWK). It is untracked and symlinked or
copied in:

```sh
git clone -b sequentia https://github.com/GracedEternalKingCabbageMan/SWK.git
cd SWK/lwk_wasm
wasm-pack build --target web --release      # --target web is required
cd -
ln -s ../SWK/lwk_wasm/pkg ./pkg
```

`index.html` imports a default-exported `init` from `./pkg/lwk_wasm.js`, which only the
`--target web` build produces. The README here omits `--target web`; SWK's README has it right.

```sh
python3 -m http.server 8080     # then open http://127.0.0.1:8080/
node --test                     # the node:test suites
```

Note that the README's claim of "three suites" is long out of date — there are ~52 `*.test.mjs`
files, and roughly twenty of them are **standalone scripts** with their own `check()` harness that
`node --test` does not pick up. Run those directly (`node covenant-byteorder.test.mjs`).

Anything importing `swap.js` from Node needs a `localStorage` shim installed before the import;
`swap.js` reads it at module load. Existing tests show the idiom.

`lightning/pkg/` is a *different* wasm artifact (the SeqLN on-device signer) and **is** tracked.
Do not confuse it with `pkg/`.

## The shape of the code

Root is flat: production modules and tests sit side by side.

- `index.html` — the wallet core: boot, balances, send/receive, fees, staking, history, OpenAMP, QR.
- `swap.js` — the Trade tab core and by far the largest file: the symmetric Pay/Receive composer.
  Routing is derived from the chosen assets. It imports the rail modules (`seqob.js`, `btc.js`,
  `covenant*.js`, `ln-rail.js`, `seqln.js`, `submarine.js`, `sbtc.js`, `subswap.js`) and three
  files from `tooling/lsp/`.
- `xswap.js`, `xrswap.js`, `xcourier.js`, `xmaker.js` — the cross-chain courier path. **These are
  live.** The RFQ client that used to sit alongside them was retired; the `xchain`/`xswap` naming
  survives on code that is very much in use. Do not delete them on the assumption they are dead
  RFQ leftovers.
- `tooling/lsp/` — the hosted-SeqLN LSP backend and its provisioning harnesses. Mostly Node-only,
  **but `settlement-router.mjs`, `unified-book.mjs` and `bridge-driver.mjs` are imported into the
  browser by `swap.js`.** They contain no `require`, no `node:` imports and no `process.` access by
  construction. Adding any of those to those three files breaks the shipped page.
- `coinjoin.js` — the Mix tab's wallet side: coin selection, ownership proofs, blinded addresses and,
  above all, `verifyRoundOutputs`, the check that decides whether to sign a transaction the
  coordinator built. `blindsig.js` and `coinjoin-protocol.js` beside it are **vendored from the
  [`seqcj`](https://github.com/GracedEternalKingCabbageMan/seqcj) repo** and must stay byte-identical
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
`covenant-byteorder.test.mjs` are pinned against the Go side. Keep them pinned.

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

`docs/ARCHITECTURE.md` predates most of the covenant and bridge work; `tooling/lsp/HANDOFF.md` is
an explicitly dated point-in-time handoff. Treat both as historical and verify against code.

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

**Author every commit as**
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
Never a personal address.

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

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
