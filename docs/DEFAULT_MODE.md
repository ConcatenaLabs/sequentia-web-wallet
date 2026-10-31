# Default mode

Concatena's Sequentia wallets (this web wallet, the browser extension, Ambra and the desktop
wallet) have two modes, kept for each wallet. This page describes what **default mode** shows
and says in all of them. The words are the same in every one of these wallets: a wallet that
needs a new sentence adds it here first. It is our design for our products; the Sequentia Wallet
Kit they build on stays neutral and imposes none of it.

## The principle

> Developer mode is where people can really mess around and use different rails than those we have
> deemed most efficient, but default mode must provide a consistent experience where all
> complexity is abstracted away from the end user so that they don't need to worry or think about
> rails at all.

In practice:

- Default mode never shows or offers a rail. The wallet chooses the most efficient route for each
  payment or trade: the operator's tree first, then Lightning or the chain. When that route
  cannot be used, the wallet falls back to the next one without asking. Only when no route works
  does it refuse, in one plain sentence, and nothing moves.
- Developer mode shows every rail by name, with its own balance and its manual controls.
- A capability reaches default mode only once the wallet can use it without asking anything, and
  its figure stays one number.

## Names

- The network is **Sequentia**. Its token is **the Sequence token (SEQ)**, tSEQ on the testnet.
- Sequence is one asset among equals. It gets no "native" label and no balance of its own at the
  top of the screen. It is set apart only where staking needs it.
- **BTC** is native bitcoin, never pegged, and is always the first row. A fresh wallet shows
  exactly one row: BTC at 0.
- Assets are named by their ticker and use their own decimals. Default mode never shows an amount
  in atoms or sats. Every amount a person reads is grouped the way Balance groups it ("500,000
  USDX"); an amount filled into a field is plain, so it can be edited.

## Balance

- Each asset has **one figure**: everything the wallet holds of it, wherever it is held. At the
  top is **one total** in the reference currency, across every asset.
- What has been received and cannot be spent yet appears under the figure as
  **"<amount> <TICKER> arriving"**. Once it can be spent, it is simply part of the figure.
- The page opens on the figures the wallet last read, every part of them, and updates them in
  place. The line above the list reads "Syncing… showing your wallet as of <time>" until each part
  has been read again, then **"Up to date."**
- A coin that could be spent, and that a Bitcoin reorganisation took back out of the chain with
  the block it rested on, stays in the figure and appears under it as **"<amount> <TICKER> being
  redone after a Bitcoin reorganisation"** until the network takes it in again. It is never shown
  as gone.
- A coin the wallet left unrefreshed while it was away is taken on the chain under its own key
  before it could be swept, by the operator or a watchtower. It stays in the figure and appears
  under it as **"<amount> <TICKER> moved out of the Ark to keep it safe while you were away"**
  while the wallet, open again, puts it back by itself; it is then arriving until that is final.
  Developer mode names it `kept_safe`.
- A coin the wallet left past its expiry, which the operator took and repays as a new coin less
  its late fee, stays in the figure while it comes back and is shown the same way, as arriving.
  The wallet claims it by itself the next time it opens, or once restored from its phrase.
  Developer mode names it `returning`.
- The row's details show only what a person may act on: **Staked**, **Arriving**, and a freeze,
  as "<amount> <TICKER> is frozen by its issuer: it can't be sent until the issuer lifts the
  freeze."
- The split by rail (on-chain, instant, Lightning) and every move between rails are in developer
  mode only.
- Any asset but BTC can be hidden from the list: it leaves the list for a folded **Hidden assets
  (<n>)** at its foot, from which it can be shown again. A hidden asset still counts in the total,
  still trades, and is still found by a picker's search; it only leaves the list and the pickers'
  first rows. Hiding is kept for each wallet.

## Asset pickers

Every place a person chooses an asset, on every surface (Trade's You pay and You receive, Send's
asset, the fee asset, Receive's amount, SeqDEX's "Priced in" menu), uses the same picker, in both
modes (`asset-picker.js`):

- A button names the asset chosen; it opens a list with a search box, "Search assets".
- Before anything is typed it lists **Your assets**: BTC first, even at 0, then every asset the
  wallet holds, each with its balance and its value, hidden ones left out. On a trade's side,
  then what the book offers now for the other side, then the other assets that trade against it.
- Typing searches every asset by ticker, name or asset id, hidden ones included, under **All
  assets**. Where an unknown asset can be used (developer mode's swap), a pasted asset id
  that no registry names is still found and can be chosen, and the line under the first rows
  reads "Type to search every asset, or paste an asset id."; elsewhere "Type to search every
  asset." With nothing found: "No matching assets." Many matches show the first forty, then
  "+<n> more · keep typing to find them."
- A picker lists only what can be chosen there: You pay what the wallet holds, You receive what
  can be had for it.
- A menu that sets what everything is priced in pins **Any** on top.

## Receive

- The card's label is **Receive code**. Under it: "Any asset, any amount. A payment from another
  Sequentia wallet arrives in seconds. Each code is paid once; a new one shows when it is."
- The code is one payment request for everything the wallet takes, BTC included:
  `BITCOIN:<ADDRESS>?ark=<ARK ADDRESS>&sequentia=<RECEIVE REQUEST>` (`pay-code.js`, whose header
  describes the format). The address is the wallet's own, the same tb1 address on both chains;
  `ark` is an address of the wallet's on the Bitcoin ark, where BTC arrives in seconds;
  `sequentia` is the single-use Sequentia receive request, in its short form (`SQR1…`). Neither
  extra part is required, so any Bitcoin wallet reads the code as a plain request for the address.
- The code is made to be scanned at a glance from another screen: upper case, so the QR code
  holds it in its alphanumeric mode, with error correction at level M. Every wallet reads codes in
  either case, and codes made before the short form.
- The code shows at once from what the wallet last drew, syncing or not, and stays until it is
  paid or its request lapses; a way to pay it that opens later is added to it in place.
- Above the code, one optional field, empty by default: "Amount in BTC (optional)". With an
  amount the code also names it (`amount=`) and carries an invoice of the wallet's on the Bitcoin
  ark for exactly that amount (`lightning=`), which a Lightning wallet pays; the invoice is
  claimed while the wallet is open, and a new one is made with the code. Without an amount the
  code carries no invoice.
- Buttons: **Copy receive code** (confirmation: "Receive code copied") and **New code**. The
  address alone is shown in developer mode.
- If the wallet cannot hold coins with the operator (the operator is unreachable, or its server
  shows another key than the one pinned), the address is shown instead and nothing is said about
  why. The wallet tries again on its own, and once it can, the code takes the address's place on
  the screen without the person leaving it.
- **Faucet** (testnet): the faucet pays the receive code. Once it says it has sent the payment,
  the amount is under the asset's figure as arriving, and when the wallet has it: "Received
  <amount> <TICKER>." If the faucet refuses the code, the wallet asks it to pay the address
  instead, in the same click. Its first button is **BTC**: the faucet pays the code's address on
  the Bitcoin ark, and the line reads "Received <amount> BTC." once it is there; while the wallet
  holds no BTC that way yet, it pays the address, and the line reads "The faucet sent <amount>
  BTC. It arrives after a Bitcoin block."

## Send

- The field is **Recipient**, with the hint "a receive code, an address or an invoice". Next to
  the asset is its one figure, "balance <amount>".
- The network fee line shows only for a payment made on the chain from the wallet's own coins.
  A receive code is paid in seconds, and a payment out of what the wallet holds for instant
  payments says its fee in the review.
- A receive code is paid the fastest way the wallet holds: an asset at its `sequentia` part from
  what the wallet holds for instant payments, BTC at its `ark` part from the Bitcoin ark, or at
  its invoice from the ark or from Lightning. Only when none of these fits is it paid at its
  address, and the review then says so first: "This can't arrive in seconds from what you hold
  now, so it goes to the address. It arrives after a Bitcoin block." (for BTC; for an asset, "It
  arrives after the next block, in about a minute."). Anything that is not a code goes the way it
  always has. The wallet chooses; nothing asks the person.
- The review is titled **Send <amount> <TICKER>?** with the line "It arrives in seconds." and the
  buttons **Cancel** and **Send**.
- When it is done: **"Sent <amount> <TICKER> (<seconds> s)."** The seconds stay in, so the speed
  can be seen.
- Refusals: one sentence each, and nothing is signed.
  - "Part of this <TICKER> is still arriving: try again in a moment."
  - "A receive code takes Sequentia assets. For BTC, use an address or an invoice."
  - "This amount can't be sent to an address right now. Send it to a receive code, or pay an
    invoice." When the wallet's coins on the chain don't cover a payment to an address, it is
    paid out of what the wallet holds for instant payments: the review is titled
    **Send <amount> <TICKER>?**, with "It arrives in a few minutes." (or "in about <N>
    minutes", from the operator's interval between settlements) and a "Fee <amount> <TICKER>"
    line when there is a fee; when done, "Sent <amount> <TICKER>. It arrives in a few minutes."
    The sentence above is for when even that cannot be made.
  - "This receive code was paid already: ask for a new one. Nothing was sent."
  - "This payment was declined; nothing was sent."

## BTC

BTC is held on a Bitcoin ark: native bitcoin, never pegged, in a wallet of the same phrase, and
part of BTC's one figure. Its address there is part of the receive code. The words are in
`BTC_WORDS` (`btc-ark.js`).

- BTC that arrives at the address and is confirmed moves there by itself; until it can be spent
  it is "<amount> BTC arriving" under the figure.
- BTC a wallet holds where it cannot be sent in seconds (its own Lightning channel, in a wallet
  made before BTC was held this way) moves there by itself too, and stays spendable where it is
  until it has. While it moves, the line under the figure reads "Moving <amount> BTC so it can
  be sent in seconds."
- The wallet keeps what it holds there current by itself, and arranges each time it is open for
  that to go on while it is closed. Nothing is shown or asked. BTC kept current while the wallet
  was closed is "<amount> BTC arriving" for the moment it takes the wallet to take it in when it
  opens.
- **Receive BTC with an invoice**: "Make an invoice for BTC. Once it is paid, the BTC is yours in
  seconds." Then "Invoice ready. Share it to receive <amount> BTC." and, when paid, "Received ✓
  <amount> BTC."
- Send, one BTC recipient: a receive code, an invoice or an address. The review is titled
  **Send <amount> BTC?** with To, Fee ("No fees" when none) and "It arrives in seconds." (for an
  address, "It arrives after a Bitcoin block."), and the button **Send**. When it is done: "Sent
  <amount> BTC (<seconds> s)." or "Sent <amount> BTC. It arrives after a Bitcoin block." With too
  little held this way, an address is paid as before; a code or an invoice is refused with "You
  can send up to <amount> BTC this way now."
- **Pay an invoice**: "Paste an invoice to pay it with your BTC." Then "Paid ✓ <amount> BTC · fee
  <fee> BTC." once the other side has taken it. While they hold it without taking it yet, "On its
  way: waiting for the other side to accept it."; if they never do, "Not paid: the payment came
  back, and the BTC is in your balance again." An invoice for anything else is refused with "This invoice asks for <TICKER>. Only
  invoices for BTC are paid here."; one larger than what is held this way with "You can pay up to
  <amount> BTC this way now."
- **A pay link**: a page that sells something for BTC hands its invoice over with
  `…/wallet/#pay?invoice=<invoice>`. The wallet opens on Send with the invoice in **Pay an
  invoice**, checked as if pasted, and nothing is paid until the person presses **Pay invoice**.
  The page that sent the link is not named.
- These two cards are the only invoice cards default mode shows, and only while the wallet holds
  BTC this way. Until then BTC is received with the receive code, whose amount field puts an
  invoice in it; an invoice handed over by a pay link shows **Pay an invoice** all the same. Invoices for other assets, the asset pickers, room to receive and the status pill
  of the wallet's Lightning nodes are in developer mode.
- A trade's BTC is paid and received the same way.

## Trade

- **You pay** and **You receive**, each an asset and an amount, then **Review** and **Trade**. The
  two amounts are tethered: the one typed stays as typed, and the other follows the best price
  the book offers now, again every few seconds while the tab is shown. Under You pay:
  "balance <amount> <TICKER>" and **Max**. Between the two sides, **⇅** ("Swap You pay and You
  receive") exchanges them: each asset takes the other's place and the amount typed goes with its
  asset, so 100 USDX typed under You pay is 100 USDX under You receive. When the book cannot fill
  what is typed: "The book can fill up to <amount> <TICKER> now." (never for what the price's
  rounding leaves, less than one atom of what is received). Review then shows the exact amounts
  and fees: what is paid can be a few atoms below what was typed, when the price leaves a
  remainder too small to buy anything, and that remainder stays in the wallet. While pricing:
  "Finding the best price…". If the price moves: "The price moved. Here is the new one."
- Fees are one line, each fee in the asset it is paid in: "Fees <amount> <TICKER>, included
  above", or "No fees". What the wallet pays to be able to receive (for BTC, the room it needs to
  take a payment) is counted as one of these fees and has no row of its own.
- Statuses: **Sent**, then **Settled**. If a trade is undone: "Returned: nothing traded." or
  "Returned: nothing traded. Fees of <fees> were paid." A purchase with BTC whose other side's
  offer ran out while it waited, and was not renewed, says "Returned: nothing traded. The other
  side's offer ran out while the trade waited."
- Settling waits for the network. Where the operator calls a coin settled once its block is
  certified (an anchor depth of 0, as on the testnet), that is a minute or two; where it also
  waits for Bitcoin blocks, a trade can take an hour or more. While it waits the row says what is
  already true, with the minutes it has waited once that is one or more: "Waiting for the other
  side. Nothing has left your wallet yet." (buying with BTC, until the asset is held for the
  wallet); "Sent (<N> min)"; and once what the trade brings is held, "Received. Settled in a
  minute or two. (<N> min)", or "Received. Settled after the next Bitcoin blocks. (<N> min)"
- Refusals: "This trade could not be made. Nothing moved."; "The other side declined. Nothing was
  traded."; "Not offered right now: nobody offers <get> for <pay> in one step."; "<get> for <pay>
  is not offered."; "Not offered right now: nobody offers anything for <pay>." (nothing can be
  chosen under You receive); "Up to <amount> can be traded now."; "Enter how much you pay."; "That amount
  is too small to trade."; "You have no <pay> to trade." (only when none is held anywhere); "Your
  <pay> is on its way: it is ready to trade in a minute or two. Nothing has moved.", or, where the
  operator also waits for Bitcoin blocks, "Your <pay> is not ready to trade yet: it is once the
  next Bitcoin blocks settle it. Nothing has moved." (held, and shown in the balance, but not yet
  where a trade pays from: just arrived, or still being moved in by the wallet); "Your <pay> is
  being redone after a Bitcoin reorganisation: it is still yours, and ready to trade again once
  that settles. Nothing has moved." (it could be traded, and a Bitcoin reorganisation took it
  back out of the chain); "Getting your <pay> ready for this trade: it is ready in a minute or two.
  Nothing has moved." (the offers are orders resting in the tree that only coins expiring later can
  fill: the wallet refreshes its older coins in the next round by itself, and prices the trade
  again while the person waits, taking the next order if that one went); "Only <amount> of your <pay> can be traded now, too little for any
  offer: the rest is on its way, ready in a minute or two. Nothing has moved.", or "… the rest is
  ready once the next Bitcoin blocks settle it. Nothing has moved." (the amount would trade, but
  most of what is held is not ready yet); "Nobody could confirm a price for this just now.
  Nothing has moved: try again in a moment."
- A price comes within seconds: every offer worth asking is asked at once, and one that has not
  answered within a few seconds is left out of the price rather than waited for.
- When a trade cannot be paid or received the way the wallet chose, the wallet takes the next
  route by itself. The person is never offered a button to pick one.
- The open tab, the pair and the amount typed are kept for the browser tab's session: a reload
  opens on them again. A ticket is not kept; Review asks for the price again.

## Market

Default mode is a trading screen, not only a form: once a pair is chosen, its market shows above
**You pay**. The words are in `MARKET_WORDS` (`market-view.js`).

- The pair is named "<base> / <quote>", one way for both sides of a trade: the same direction the
  rest of the wallet prices it in ("1 <base> = N <quote>"). The quote is the asset people price the
  other in: when BTC pairs with a fiat stablecoin, the stablecoin is the quote ("1 BTC = 77,200
  USDX"); against any other asset BTC is the quote ("1 GOLD = 0.05 BTC"); otherwise a fiat
  stablecoin is the quote, and between two other assets the order is fixed by their ids.
- Under it, the last price in the quote's units and its change over the last 24 hours, with
  "24h". Then "High <price> · Low <price> · Volume <amount> <base>" for the last 24 hours.
- A price chart, with three ranges: **1D**, **1W**, **1M**, its times along the bottom and its
  prices on the right. A price holds until the next trade, so the line is a step. Under it, the
  chart library's notice: "Charts by TradingView Lightweight Charts™", a link to TradingView.
- **Best bid** and **Best ask**, then a bar of the book's depth on each side, "Buyers <n>%" and
  "Sellers <n>%". With no order on either side: "Nobody is buying or selling right now".
- **Recent trades**: price, amount and time ("<n> minutes", as ago), newest first; a buy in green,
  a sale in amber.
- When a pair has little history, it says so and shows what there is: "No trades yet", or "No
  trades in the last 24 hours · Last trade <price> <quote>, <time> ago" (the last price stands,
  with no 24-hour change), or, on a chart range with no trade in it, "No trades in this range".
- Below the button, **Your trades**, in two groups: **Open** (trades still settling, with their
  status) and **Past**.
- Every figure comes from SeqDEX's relay, whose one trade log per market holds every trade
  however it settled, so the market reads the same in every wallet and on SeqDEX. Default mode
  never says how a trade settled; developer mode adds a **Rail** column to the recent trades and
  the book's depth by rail.
- The view reads the relay again every five seconds while it is on screen.
- The chart is drawn the same way on every surface (SeqDEX's `shared/chart.js`, with TradingView
  Lightweight Charts): buys green, sales amber, a step line or candles, and the ranges above.

## SeqDEX

SeqDEX's site is the most complete place to trade, and its default view uses this page's words.
What it shows beyond the Market and Trade sections above:

- **Markets**: every pair with **Last price** (in the quote, its value in the reference currency
  beside it), **24h change**, **24h high / low**, **24h volume** (in the reference currency) and
  a **7 days** line. A pair with no trade says "No trades yet". Filters: **All**, BTC, each fiat
  stablecoin, **Favourites**, **You hold**.
- **The chart**: **Price** or **Depth**; ranges 1D, 1W, 1M, then **3M**, **1Y** and **All**;
  **Candles** or **Line**; **Indicators**: "Volume", "Moving average 7", "Moving average 25",
  "EMA 20", "Bollinger bands 20, 2", "VWAP", "RSI 14".
- **Order book** and **Recent trades**. Between the two sides: the last price, then "Spread
  <amount> · <percent> · Mid <price>". A book whose best bid is above its best ask is shown as
  it is.
- **The order ticket**: **Buy** or **Sell**; **Market**, **Limit** or **Auction** ("Trades at the
  next auction's one price, at your limit or better."); **Price** (for a limit or an auction),
  then **You pay** and **You receive**, tethered as in the Trade tab: the amount typed stays and
  the other follows (at the limit price for a limit order, by walking the book for a market
  order), with "The book can fill up to <amount> <TICKER> now." when it cannot; and 25%, 50%,
  75%, **Max** of what can be paid. Under **Options**:
  - **Post only**: "Rest on the book without taking any order."
  - **Nothing left resting**: "Take what is on offer at your price now; the rest is not placed."
  - **Smallest fill** <amount> <TICKER>.
  - **Can take back after** 1 hour, 1 day or 1 week: "Until then it stays on the book for anyone
    to fill at your price."
  An option or a type shows only when the connected wallet offers it.
- The ticket's estimate for a limit: **Fills now** <amount> at <price>, **Rests on the book**
  <amount> at <price>; under the button, "Your wallet shows the exact amounts and fees
  before anything is signed." The button reads "Buy <amount> <TICKER>" or "Sell <amount>
  <TICKER>".
- Refusals, besides the Trade section's: "You declined in the wallet. Nothing was traded." and,
  for post only, "This order would trade at once. Nothing was placed." (against BTC, "An order
  against BTC trades at once and never rests on the book. Nothing was placed."), and for a
  smallest fill larger than the order, "The smallest fill is more than the order. Nothing was
  placed."
- **Your orders**: **Open orders** (with **Filled** <percent>, and "Can take back from <time>"
  or a **Take back** button), **Trades** (each row as in History, with **Sent** or **Settled**),
  **Order history**, and "This market only".
- **Portfolio**: **Total** in the reference currency with its 24h change, then each asset's one
  figure, its price, its 24h change, its value and its share; **Export CSV**.
- Developer view adds a **Route** column, each route's own book, the route the wallet proposes on
  the ticket, and **Two-sided** orders (a bid and an ask from two coins).

## History

- **One row per payment or trade.** A trade is one row, however many legs it has.
- A trade's row is "Swapped <pay amount> <TICKER> for <get amount> <TICKER>", then a small line
  with the time and, while the trade is not settled, its status. On the right are
  "-<pay> <TICKER>" and "+<get> <TICKER>", then "fee <amount> <TICKER>" when there was one.
- A payment's row has its description (or "Received" / "Sent"), its time and its amount as +/-.
- A payment is in History the moment it leaves, and a payment arriving as soon as the network has
  it. This holds for what is paid and received in seconds too, and for every trade of the Trade
  tab: the wallet writes each down as it happens, in the browser that holds it, and shows them
  in the one list, by time, with what the chain holds. While it waits for a block, its time line ends with "Waiting for a Bitcoin block" (BTC) or
  "Pending", and that goes once it is confirmed.
- Which rails a trade used ("BTC on-chain · GOLD over Lightning", "over Lightning") is shown in
  developer mode only.

## Connect

A site that trades through a wallet (SeqDEX) offers every wallet it can reach, in the same words:

- The button reads **Connect wallet**, or **Get a wallet** when none is there. Once connected:
  "Connected" and the address, shortened.
- It opens a list headed "Connect with": **Sequentia web wallet**, **Ambra mobile**,
  **Ambra browser** and **Sequentia Core on this computer**, each marked "Ready",
  "Connected", "Not open" (the web wallet), "Pair" or "Paired" (a phone), "Not installed" (the
  extension) or "Not running" (Sequentia Core). The web wallet not open opens it in a new tab,
  with "Open your web wallet in the new tab, then choose it here again."; a phone not paired
  shows "Pair Ambra mobile", a code to scan and "Open in Ambra mobile on this phone",
  then "Waiting for your wallet…"; a paired phone has **Forget**; any other wallet that is not
  there opens where to get it.
- With no wallet at all, under the bar: "SeqDEX needs a wallet. Every order and every settlement
  is signed inside your wallet; this site never holds keys or funds.", then where to get each.
  Where a form needs one: "Trading needs a wallet: the Sequentia web wallet, Ambra mobile, Ambra
  browser, or Sequentia Core on this computer through sequentia-connect."
- The wallet asks its owner before anything is signed, in its own window or screen (the web
  wallet's page, the phone's screen, the extension's window), or, for Sequentia Core on this
  computer, in the terminal sequentia-connect runs in; the site waits with "Waiting for your
  approval in the wallet…".
- The wallet's side, in every wallet: a site asks once to connect ("Connect SeqDEX?", with the
  site's address; on a phone, the address is what the site says it is, shown as that), then
  each order shows **Trade?** (You pay, You receive, Fees, Asked by) or **Place an order?** (You
  sell, For, Price, Smallest part filled, Fees, What is left can be taken back from, Asked by),
  and **Approve** or **Reject**. A rejection reaches the site as "the user rejected the
  request".

## Report a problem

Every wallet has **Report a problem** where a person looks for help: in the web wallet, in More
and at the top of Help. The words are in `REPORT_WORDS` (`problem-report.js`).

- The intro: "Tell us what went wrong. Reports help fix the testnet before more people use it."
- **What happened?**, with the hint "What you did, what you expected, and what happened
  instead.", then **Emissio account code (optional)**: "Paste it to be credited if the report is
  accepted."
- Under them: "The report includes this wallet's version, its mode and its recent errors. It
  never includes your recovery phrase or your keys." The web wallet's version is when the page
  was published ("Version <date> <time> UTC" in the footer); the apps report their own. The
  recent errors are the last twenty the
  wallet threw or showed, with anything shaped like an address, a key, an invoice or a long hex
  string replaced before they are kept.
- A box, unticked: **Also send my address**. Ticked, it shows "This address will be sent:" and the
  address. No key and no phrase is ever sent.
- **What will be sent**, folded: the exact report, as it changes.
- **Send report**. When it is done: "Report sent. Its number is #<n>. Thank you.", then "If it is
  accepted, it is credited to your Emissio account." or "That account code was not found, so the
  report was sent without it."
- Refusals: "Describe what happened."; "This looks like your recovery phrase. Never share it with
  anyone: remove it, then send again." (three words of the wallet's phrase in a row); "This report
  was already sent."; "Too many reports from here. Try again later."; "This report is too long.
  Shorten it, then send again."; "The report could not be sent. Check your connection and try
  again."
- Reports go to Emissio's intake (`/emissio/api/problem-reports`); its README holds the contract.

## Never in default mode

None of these words appear on any screen in default mode, in the wallet's own text: rail,
round, leaf, operator, tree, board, covenant, expiry, atom, sat, forfeit, checkpoint,
reassignment, exit, unroll, anchor, channel, node, room, relay, maker, hash, preimage, HTLC,
submarine, LSP, bridge, gateway, on-chain, Lightning. Nor do these controls: a choice of rail, a
move between rails, a receive request form, an exit drill, contract internals, a fee-rate field,
or a "native asset" label. A refusal the wallet passes on from another service is said in
these words too, never in the service's own.

The web wallet holds its list in `USER_MODE_FORBIDDEN_WORDS` (`user-trade.js`), and each wallet
tests its default-mode strings against the list.

## Checked after every deploy

Each rule on this page is a line of the regression suite in
[sequentia-testnet-ops](https://github.com/ConcatenaLabs/sequentia-testnet-ops/tree/main/regression),
which reads the live testnet in a headless browser, at desktop and phone widths, and says pass or
fail for each. A rule added here gets its line there in the same sitting.
