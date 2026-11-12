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

- Each asset has **one figure**: everything of it the wallet can trade or send now, wherever it
  is held. At the top is **one total** in the reference currency, across every asset. All of the
  figure can be traded or sent at any moment, on whatever route the wallet picks; which route,
  and any limit behind it, is never shown, and nothing is asked.
- A payment that is not the wallet's to spend yet is **not in the figure**. It shows only in
  History, as **Arriving**, with when it will be in words: "about a minute". Nothing under the
  figure says that part of anything is locked, waiting or on its way.
- What counts at once: the wallet's own money, what a trade brought it, and payments from others
  up to a small amount, 500 US dollars across every asset, at the wallet's node's prices (or less,
  when the operator suggests less). A payment from another Sequentia wallet within that is in the
  figure the moment it arrives, and can be paid on at once. Past it, a payment arrives: the wallet
  has it made its own in the operator's next settlement (a median of about a minute), and it is
  then in the figure. Payments count in the order they came, and one that counted never leaves
  the figure again, neither for a change in prices nor when the wallet pays out of it (its change
  keeps its place). A payment the wallet cannot value arrives; receiving never stops for it.
- A deposit to the wallet's address on Sequentia is arriving from the moment the wallet sees it
  until it is money the wallet can use: in the mempool, then, for an asset the wallet moves into
  the Ark by itself, until that move is final. It counts once, then, and never leaves the figure
  again. Its line says "usually within <N> minutes", N from the operator's anchor depth (a Sequentia
  block, and ten minutes for each Bitcoin block that must bury the move's anchor, rounded up to
  five). The wallet's own change from a payment it made counts at once.
- A wallet opened in a browser for the first time (a restored phrase, a new device, a cleared
  profile) first finds what it holds. Until it has, the line under the total reads "Syncing…
  finding everything this wallet holds." rather than any figure as of a time, Receive shows the
  address with "Your address, the same tb1 address on both chains. Your receive code shows here
  once the wallet has found everything it holds.", and a payment or a trade asked meanwhile reads "Your wallet
  is still opening; this goes on by itself once it has." and goes on once it has. A wallet with a
  long history takes a few minutes: after two, the line reads "Syncing… this wallet has a long
  history, so finding everything it holds takes a few minutes. Nothing has moved, and it opens by
  itself once it has." After thirty, far longer than any history should take, it reads "Syncing…
  finding everything this wallet holds is taking far longer than it should. Nothing has moved,
  and your coins are still yours. Reload the page to start again.", and a payment or trade still
  waiting reads "Your wallet is taking far longer than it should to find everything it holds, so
  nothing has moved. Reload the page to start again; your coins are still yours." If the service that holds its coins for instant payments does not answer, the
  wallet is never shown empty: the line reads "Syncing… the service that holds your coins for
  instant payments is not answering, so this wallet has not found them yet. They are still
  yours, and show here once it answers.", the wallet asks again every half minute, and a trade,
  or a payment that what it holds elsewhere does not cover, reads "The service that holds your coins
  for instant payments is not answering, so this wallet has not found them yet. Nothing has
  moved. They are still yours: they show in your balance once it answers, and can be sent from
  then." A wallet that is not finding what it holds and has not opened within three minutes reads
  "Your wallet has not finished opening, so nothing has moved. If it does not open, reload the
  page."
- The wallet keeps its money in ordinary coins: it opens no channel, names none in its receive
  code, and closes any it holds into a coin at the next settlement. Until then what it held there
  (its own side alone) is in History as **Coming back**, "about a minute", not in the figure.
- A payment received past what counts at once shows under its asset the moment it is received:
  **"<amount> <TICKER> arriving, in about a minute"**; an asset held only that way reads
  **Arriving** in place of a figure, never 0. The wallet gives it to the very next settlement at
  once (at the wallet's opening too), unless the person is asking it something.
- Developer mode shows every part under the figure, **"<amount> <TICKER> arriving"** included
  (and moving, redone, kept safe), counts every payment at once, and keeps its channels and
  their choices.
- What the wallet holds that cannot move before a date, such as tokens bought in a sale that
  vests, is part of the figure and appears under it as **"<amount> <TICKER> vests on <date>"**,
  the date in words: "100 ORNG vests on 3 November 2026". One line for each date. An asset held
  only this way still has its row. It is never counted as what can be spent, and every Max
  leaves it out. From that date the wallet takes it by itself, and it is
  then part of the figure, arriving until that is final. Developer mode lists it with the rest of
  the wallet's claims.
- The page opens on the figures the wallet last read, every part of them, and updates them in
  place. The line above the list reads "Syncing… showing your wallet as of <time>" until each part
  has been read again, then **"Up to date."**
- A coin that could be spent, and that a Bitcoin reorganisation took back out of the chain with
  the block it rested on, is arriving again until the network takes it in again: it leaves the
  figure for History's **Arriving**, and is never shown as gone. Developer mode says so under the
  figure: **"<amount> <TICKER> being redone after a Bitcoin reorganisation"**.
- A coin the wallet left unrefreshed while it was away, or one paid to it whose sender took an
  earlier coin of its lineage back on the chain, is taken on the chain under its own key by the
  operator or a watchtower: the wallet deposits each coin, sealed and with nothing shown, with
  the watchtowers its operator names and those the other operators run for its users. While it
  is on the chain and while the wallet, open again, puts it back by itself, History shows it as
  **Coming back**, "within about two days"; it is in the figure again once it is back. Developer mode says so under the figure, **"<amount> <TICKER> moved out of the Ark to
  keep it safe while you were away"**, and names it `kept_safe`.
- A coin another wallet paid this one is made the wallet's own in the operator's next settlement,
  by itself, which ends what its senders could still do with it. One that is arriving goes into
  the very next settlement, ahead of others; one that counted goes when the wallet has been left
  alone two minutes, or holds more than half of what counts at once. A counted coin given to a
  settlement still pays: a settlement that waits for the operator is taken back after two
  minutes, and a payment or a trade that needs the coin takes it back first. Nothing is said about
  it. A page can turn this off (`window.SEQ_REFRESH_RECEIVED = false`).
- A coin the wallet left past its expiry, which the operator took and repays as a new coin less
  its late fee, is shown in History as arriving while it comes back.
  The wallet claims it by itself the next time it opens, or once restored from its phrase.
  Developer mode names it `returning`.
- What a wallet holds where it cannot be sent in seconds (its own Lightning channels, in a
  wallet made before its coins were held this way) moves by itself to where it can: BTC to the
  Bitcoin ark, every other asset into the operator's tree, claimed at the next round. Nothing is
  asked. A move is paid only from a channel that is open for payments, within the day's
  Lightning payment limit when the wallet sets one (nine tenths of it, the rest on a later day),
  an asset's within the most the operator takes in one payment over Lightning (the rest on a
  later pass), and never while the person is using the wallet. It stays in the figure while it moves, counted
  once, whether the channel or its new place reports it first; nothing under the figure says it
  moves (developer mode reads **"Moving <amount> <TICKER> so it can be sent in seconds."**). A
  payment refused before it left moves nothing and is tried again later. A channel the move
  emptied is closed to the wallet's address when that is cheap and safe, and what it held stays
  in the figure on its way back; otherwise it stays, and developer mode says why under its Lightning part.
- The row's details show only what a person may act on: **Staked**, **Vests on
  <date>**, and a freeze,
  as "<amount> <TICKER> is frozen by its issuer: it can't be sent until the issuer lifts the
  freeze."
- The split by rail (on-chain, instant, Lightning) and every move between rails are in developer
  mode only.
- Any asset but BTC can be hidden from the list: it leaves the list for a folded **Hidden assets
  (<n>)** at its foot, from which it can be shown again. A hidden asset still counts in the total,
  still trades, and is still found by a picker's search; it only leaves the list and the pickers'
  first rows. Hiding is kept for each wallet.

## When the service does not answer

The coins a wallet holds for instant payments rest with a service. If that service stops
answering, the coins are still the wallet's, and the wallet can take them home to its own
address from what it holds and the chain alone, without the service.

- While the service does not answer, Balance shows one card above the list: "The service that
  holds your coins for instant payments is not answering. Your coins are still yours: wait for
  it to come back, or take them home to your own address now." and one button, **Take my coins
  home**. The figures stay as they are. The card goes once the service answers again.
- The button opens a review, **"Take your coins home?"**, with one line for each asset:
  "<amount> <TICKER>, network fees about <fee> <TICKER>", the fees being what the holder pays,
  in the asset taken home, then "They reach your own
  address in about <hours> hours, and cannot be sent until then. Open this wallet again after
  that to finish." A coin that cannot go now says "<amount> <TICKER> cannot be taken home right
  now. Nothing of it was sent: try again later." The button is **Take them home**.
- Once sent, each asset reads "<amount> <TICKER> on its way to your own address: it arrives in
  about <hours> hours, once this wallet is open.", in the review and on the card, until it has
  arrived; it stays in the figure meanwhile. Where the wallet no longer knows when it was sent
  (another browser sent it), the line is "<amount> <TICKER> on its way to your own address."
- When nothing can go, the review says "None of your coins can be taken home right now. Nothing
  was sent: try again later."
- Developer mode keeps its own way: Leaves names the operator as unreachable and lists every leaf
  with its Exit drill, one leaf at a time, each step and fee shown before it is broadcast.

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

- **With a payment name** (below), Receive shows the name: the card's label is **Your payment
  name**, the QR code holds `name@sequentiatestnet.com` in lower case and nothing else, and the
  name is written under it (a word name with a capital for each word, `AmberFalcon@…`); **Copy
  name** copies it in lower case, as the QR code holds it. Under the label: "Any asset, any amount, a new receive code of yours
  for each payer. A Sequentia wallet can pay this name while this wallet is closed; other wallets,
  while it is open." Under the name: "Anyone who has your name can look it up and get a receive
  code of yours." Buttons: **Copy name** and **Show full code**; there is no New code, since every
  payer gets a new code anyway. Under them the Confidential switch, and at the foot of the same card
  **Remove name** as a quiet link: one card, the name said once. The amount field and the Confidential
  switch stay: an amount typed, or Confidential on, shows the full code as below, and so does
  **Show full code** (for a wallet that can't look names up, or to pay without a connection), whose
  line reads "For a wallet that can't look names up, or to pay without a connection. Each code is
  paid once; a new one shows when it is." and whose **Show name** goes back. Leaving Receive
  shows the name again next time.
  - Why the bare name in the QR code: it is the one spelling every wallet that pays names reads
    from a scan. `lightning:name@domain` is refused by some wallets' scanners (more of them in upper
    case, which LUD-16 does not allow), and BIP353's `₿name@domain` needs a DNS record that is not
    published. Every Concatena wallet reads all three, from a scan or typed.
  - A payer's wallet that looks the name up gets a full receive code of this wallet's, signed by the
    name's key, and checks the signature before paying (Send, below). The codes come from a stock
    the wallet leaves with the name service (`name-stock.js`): ten at a time, each at an address of
    its own within the twenty New code cycles through, each handed out once. The wallet tops the
    stock up whenever it is open, so a payer is never turned away while the wallet is closed: when
    the stock runs out, the most recent code is handed out again, and is paid at its address or its
    ark address (its single-use part is left out). No code ever uses an address past those twenty,
    so a wallet restored from its phrase finds every payment.
  - Lookups are limited per name and per network, so nobody can empty the stock: past a name's
    limit a lookup gets the most recent code again, and past a network's it is refused for a minute
    ("Too many lookups from your network. Try again in a minute.").
- Without a name, the card's label is **Receive code**. Under it: "Any asset, any amount. A payment from another
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
- A new code the operator cannot give at that moment (a restart, a dropped connection) is asked
  for again by itself: twice at once, under "Making your receive code…", then with a growing pause
  of up to a minute, showing the wallet's address meanwhile so a payer can still pay. The code
  comes back as soon as the operator answers.
- Above the code, one optional field, empty by default: "Amount in BTC (optional)", with a menu
  beside it of what the amount is in: **BTC**, and each asset the operator receives over
  Lightning (the menu shows only when there is more than BTC; for an asset the field reads
  "Amount (optional)"). With an amount in BTC the code also names it (`amount=`) and carries an
  invoice of the wallet's on the Bitcoin ark for exactly that amount (`lightning=`), which a
  Lightning wallet pays. With an amount in an asset the code carries instead an invoice in that
  asset of the operator's node (`lightning=`, the leaf library's `lightning_receive`), which a
  wallet of another operator pays in seconds; `amount=` is left out, since it counts BTC. Either
  invoice is claimed while the wallet is open, and a new one is made with the code. A payment of
  an invoice in an asset reaches the wallet in the operator's next round (about a minute) and only
  through a sync of its leaves, so the page follows each such receive itself, whatever the Receive
  card shows and with the tab in front or behind: while nothing is paid it asks the operator how
  the receive stands (every 3 seconds for an invoice under ten minutes old, every 30 after that),
  and once a payment is held it syncs every 10 seconds until the payment is in the balance; a
  step of something the person asked for under way holds those syncs back. Without an
  amount, a wallet with a payment name (below) carries that name in the code instead, as its
  LNURL-pay (`lightning=LNURL1…`, the LUD-01 form of `https://<domain>/.well-known/lnurlp/<name>`),
  which any Lightning wallet pays in an amount it chooses; a wallet without a name carries no
  Lightning part. Readers take an LNURL in `lightning=` as the name it is, never as an invoice, so
  a Sequentia wallet pays such a code at its other parts as it pays any code.
- Buttons: **Copy receive code** (confirmation: "Receive code copied") and **New code**. The
  address alone is shown in developer mode.
- **New code** moves the code to an address it has not shown, with a new receive request, ark
  address and invoice. It starts from the first address neither chain has seen paid and goes
  through the twenty after it, then begins again from the first: a wallet restored from its phrase
  reads twenty addresses past the last one paid, so a payment to any code it ever showed is found.
  The address shown is kept, so a reload shows the same code while it is unpaid; once it is paid,
  the next code moves past it. Developer mode's **New address** follows the same rule
  (`receive-index.js`).
- **Confidential**, a switch under the buttons, off whenever Receive is opened: "Asks the payer
  to hide the amount, and the asset where it can, from everyone but you and them." It asks: what
  is hidden is made by the payer's wallet (a Concatena wallet pays it as under Send, below). On, the code is the wallet's
  confidential address alone (`tsqb1…`, as Sequentia wallets read any address), with no amount
  field and no other part, and the line under the card reads "Any Sequentia asset, any amount,
  paid to your confidential address."; under the switch: "Everyone can still see that a payment
  was made. A payment that arrives in seconds is never confidential, so this one arrives after the
  next block, in about a minute. BTC is never confidential: to receive BTC, turn this off." A
  payment in seconds is never confidential because the operator publishes every leaf of a round
  with its asset and value; BTC has no confidential form on Bitcoin. New code moves it to a new
  address as it does the code. The same switch shows under the address while the wallet cannot
  hold coins with the operator. Developer mode keeps its own address view.
- If the wallet cannot hold coins with the operator (the operator is unreachable, or its server
  shows another key than the one pinned), the address is shown instead and nothing is said about
  why. The wallet tries again on its own, and once it can, the code takes the address's place on
  the screen without the person leaving it.
- **Faucet** (testnet): the faucet pays the receive code. Once it says it has sent the payment,
  the amount is under the asset's figure as arriving, and the wallet reads its mailbox for it at
  once (never a whole update); when the wallet has it: "Received <amount> <TICKER>." Should the
  wallet not have taken it in within 45 seconds (it was finishing an update), the line reads "The
  faucet sent <amount> <TICKER>. It shows in your balance as soon as your wallet has taken it in,
  usually within a few minutes.", and turns to "Received …" when it arrives. A faucet busy with
  other requests says so in its own words, and the wallet does not ask it to pay the address
  instead. If the faucet refuses the code, the wallet asks for a new code once (the one shown may
  have been paid or have lapsed meanwhile), and then asks it to pay the address instead, in the
  same click. Its first button is **BTC**: the faucet pays the code's address on
  the Bitcoin ark, and the line reads "Received <amount> BTC." once it is there; while the wallet
  holds no BTC that way yet, it pays the address, and the line reads "The faucet sent <amount>
  BTC. It arrives after a Bitcoin block." The faucet pays each asset once per wallet: the card says so, a
  button whose asset the wallet has received reads "<TICKER> received" and is off, and a refusal
  is the faucet's own sentence ("This wallet has already received its <TICKER> from the faucet.
  The faucet pays each asset once per wallet. To get more, trade for it in the wallet."), with
  no second try at the address.
- **Your payment name**, under the code or the name: a name of the wallet's own at the site's domain
  (`name@sequentiatestnet.com`), which another wallet pays in an amount it chooses, a Lightning
  wallet included (it is a Lightning address, LNURL-pay, `lnaddr.js`). Without a name the card
  reads "Get a name other wallets can pay you at, in any amount they choose." with **Get a name**,
  and **Choose your own** as a quiet link. **Get a name** gives the wallet its word name in one
  tap (`word-name.js`): two words from a list, written together and shown with a capital for each
  word (`AmberFalcon@sequentiatestnet.com`), derived from the key that holds the name, so a wallet
  restored from its phrase gets the same name back. A third word is added only when the two-word
  name is taken; never more. The QR code, Copy and every payer's lookup use the name in lower case
  (`amberfalcon@sequentiatestnet.com`), since some wallets refuse capitals in a name; lookups ignore
  case, so a name typed with capitals pays the same wallet. Names are unique as the joined lower-case
  string. The words are the EFF short wordlist less every BIP39 word, so no word of a recovery phrase
  is ever part of a public name. **Choose your own** opens a field ending in "@sequentiatestnet.com"
  with **Save** and **Cancel**. A wallet holding a name of its own choosing sees **Use a word name
  instead**, a quiet link that swaps it for its word name in one tap. With one it shows the name, "Other wallets can pay you at this name, in any amount
  they choose. A Sequentia wallet can pay it while this wallet is closed; other wallets, while it is
  open.", **Copy** and **Remove name**. A name is 3 to 32
  lowercase letters, digits, `-` and `_`; refusals: "A name has 3 to 32 characters: lowercase
  letters, digits, - and _." and "That name is taken. Choose another.". The name is held by a key
  of the wallet's phrase, so a wallet restored from the phrase shows it again. A Sequentia wallet
  paying it gets one of the signed codes of the stock, open or closed. A Lightning wallet paying it
  picks the amount first, so the invoice can only be made by the open wallet, on the Bitcoin ark;
  while the wallet is closed such a payer is told "The recipient's wallet is offline. Try again
  when it is open." and nothing is held for it by anyone. Developer mode calls it **Lightning
  address** and says how it works. A wallet with no phrase has no name.

## Send

- The field is **Recipient**, with the hint "a receive code, a payment name, an address or an invoice". Next to
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
- A payment name (`name@domain`, also read as `lightning:name@domain` or `₿name@domain`, typed or
  scanned) is paid as what it stands for. A name at the site's own domain is paid at a receive code
  its wallet left signed with the name service, any asset, as any code is. The code must carry the
  signature of the key published beside the name, over the name, the domain and the code; the
  wallet keeps the key it first paid each name at, and refuses a code under another key. A code
  handed out before, or whose single-use part lapses within ten minutes, is paid without that part.
  Refusals, with nothing sent: "This name gave a receive code its wallet did not sign, so nothing
  was sent. Ask the recipient for their full code." and "This name now belongs to another wallet
  than the one you paid before, so nothing was sent. Ask the recipient for their full code."; a
  name
  at another domain (a Lightning address of another wallet) takes BTC only, and is paid at the
  invoice that service makes for the amount, which must be for BTC and for exactly that amount.
  Refusals: "No wallet goes by that name.", "The recipient's wallet is offline. Try again when it
  is open.", "Too many lookups from your network. Try again in a minute.", "This address takes BTC
  only.", "Enter an amount.", "This address takes between
  <least> and <most> BTC.", and "The address could not be reached. Check your connection and try
  again."
- An asset sent to a receive code of a wallet of another operator (its `sequentia` part names
  another operator) goes over Lightning when the code carries an invoice in that asset for
  exactly the amount sent (the row takes the asset and amount from it when its amount is
  empty), the payment is within the limit the operator publishes for one payment out over its
  node in the asset (`max_payment`, by default a tenth of what the node can send less what it
  keeps for swaps: its channels are shared by every user and by the swaps, and one large payment
  would drain them; 1,500 USD when the operator publishes none), the operator's node in the asset is up, and the invoice's final lock fits the operator's window for a payment with a hop
  to spare (`asset-lightning.js`). The review is the tree's: **Send <amount> <TICKER>?**, "It
  arrives in seconds.", a "Fee" line when there is one. Once sent it reads "On its way: it
  arrives once the other wallet takes it." until the other wallet takes it, then "Sent <amount>
  <TICKER> (<seconds> s).". Otherwise it is paid at the code's address, and the review says why
  first: "A payment of more than <limit> USD to this wallet goes to the address." above the
  limit, or "This can't arrive in seconds right now, so it goes to the address." when the way
  cannot carry it (or the asset has no price to hold it to the limit), each followed by "It
  arrives after the next block, in about a minute." A payment refused on its way, or that came
  back, says so ("This couldn't go through in seconds, and nothing was sent." / "This couldn't
  go through in seconds and came back to you.", then "Send it to the address instead? It arrives
  after the next block, in about a minute.") with the button **Send to the address**.
- Under the amount of a payment to a receive code in the tree, while it is typed and before any
  review, one line from the leaf library's quote of that very payment (`send_quote`, or its
  refusal): "Fee <amount> <TICKER> (< 0.01 USD) · arrives in seconds"; "Fee … · takes about a
  minute. Up to <instant> <TICKER> goes instantly." when part of it must come back from the
  wallet's side of its channel with the operator first (`in_channel`; about 10 minutes for BTC);
  "You can send up to <most> <TICKER>: the fee comes out of your balance." above the most. **Max**
  fills in that most, not the whole balance.
- The review is titled **Send <amount> <TICKER>?**, the amount the recipient gets, with its rows
  **Fee** "<amount> <TICKER> (≈ <value>)" (in cents, "< 0.01 USD" below a cent, in BTC as it is;
  "No fees" over a channel) and **Total**, what leaves the wallet, the fee on top of the amount;
  then "It arrives in seconds.", or, when part of it must come back from the channel first,
  "This payment takes about a minute because it is larger than what you can send instantly, so it
  waits for the next block. You can send up to <instant> <TICKER> instantly. Keep this page open."
  (the same line while it waits; "about 10 minutes" for BTC); and the buttons **Cancel** and
  **Send**. Asked for more than can go once the fee is out, the review is for the most, with "The
  fee comes out of your <TICKER>, so this is the most you can send."; refused for want of the fee
  after the wait, Send becomes **Send <most> <TICKER>**, reviewed again before anything is signed.
- When what is sent waits only for the next settlement (the wallet's own upkeep is moving the
  asset in it, or coins must be settled first, such as a payment received that is still
  arriving), the review goes on with "Goes through in about a minute" in place of "It arrives in
  seconds."; **Send** then waits for that settlement, saying the same, and the payment goes ahead
  by itself after it. It is never refused for it: what is still arriving counts in what can be
  sent, to a receive code, to an address, and in a move out of the Ark.
- The wallet's maintenance puts no part of an asset into a channel while a payment of it is being
  written (a recipient or an amount typed), for ten minutes after a payment closed a channel to
  spend its side (an hour for BTC; kept across reloads), nor while it holds less than 10 USD of it.
- When it is done: **"Sent <amount> <TICKER> (<seconds> s)."** The seconds stay in, so the speed
  can be seen.
- A payment of an asset from the wallet's own coins on the chain has the same review, titled
  **Send <amount> <TICKER>?**, with "To <address>", its "Fee <amount> <TICKER>" and "It arrives
  after the next block, in about a minute.", and the buttons **Cancel** and **Send**: no network,
  no fee asset, no transaction id. Once it is broadcast: "Sent <amount> <TICKER>. It arrives after
  the next block, in about a minute." Developer mode keeps its own review, with the network, the
  fee asset and the transaction.
- Refusals: one sentence each, and nothing is signed.
  - "You can send up to <amount> <TICKER> this way now: a payment keeps a little back for its fees."
    when the wallet cannot spend the whole amount now: <amount> is what its spendable coins hold less
    what the payment keeps back for the fees of the transactions it keeps ready, so sending that much
    goes through. The library's own refusal goes to the console.
  - "None of your <TICKER> can be sent this way right now: try again in a moment." when none of it
    can be, and nothing of it is arriving.
  - "A receive code takes Sequentia assets. For BTC, use an address or an invoice."
  - "This amount can't be sent to an address right now. Send it to a receive code, or pay an
    invoice." When the wallet's coins on the chain don't cover a payment to an address with its
    network fee, it is paid out of what the wallet holds for instant payments: the review is titled
    **Send <amount> <TICKER>?**, with "It arrives within <N> minutes. Keep this page open
    meanwhile." and a "Fee <amount> <TICKER>" line when there is a fee (Ambra mobile says
    "screen"). The paying wallet signs its part of the operator's settlement as it is made: a
    wallet closed before then makes nothing, and its coins stay its own. So after Send it reads
    "Sending <amount> <TICKER>. Keep this page open until it is sent." until the wallet's leaf
    library says the payment is made (its `offboards` reads `unlocking` or `paid`), and only then
    "Sent <amount> <TICKER>. It arrives within <N> minutes." "Sent" is never shown for a payment
    the library has not made. The wallet follows each such payment to its end, while the review
    is open and afterwards. One that ended without being made (`not_made`) says "Your payment of
    <amount> <TICKER> to <address> was not made: nothing left your wallet. Send it again." in the
    review when it is still open, and otherwise once, on a card above Balance's list with the
    button **OK**, the next time the wallet is open; its History row reads "Not sent", with
    "Nothing left your wallet." and the amount struck through. One made and then taken back by
    the service before it reached the address (`reclaimed`) says "Your payment of <amount>
    <TICKER> to <address> did not arrive. Report a problem, so it can be put right." the same
    way, its row "Did not arrive". The address is shown by its first fourteen and last four
    characters. <N> is the most the whole way to the other wallet's figure takes, never the
    operator's settlement alone: the interval between its settlements, four blocks (the
    settlement's, the operator's payment to the address, and the paying wallet handing over its
    part between them) and four minutes for the wallets to read the chain, rounded up to five
    minutes: ten on the testnet. The same amount of the same asset to the same address, asked
    again while the first is still on its way, is that first payment: nothing more is sent, and
    the wallet says "<amount> <TICKER> to this address is already on its way, so nothing more was
    sent. It arrives within <N> minutes. Keep this page open meanwhile. To pay the same again,
    send once it has arrived." When the wallet's coins of the asset are still arriving (the change
    of a payment just made, a coin just received) and would cover the payment once they are in,
    the review opens all the same, its fee line "A small part of what you send, shown once it is
    sent" and <N> one settlement longer; **Send** reads "Goes through in about a minute" while
    the wallet settles them, then the payment is made as above. What a payment still on its way
    gives up counts only as its change. The sentence above is for when even that cannot be made.
  - "<amount> <TICKER> of this vests on <date>, and can be used from then. Nothing has moved."
    when what is asked for needs what has not vested yet. Trade, Stake, Mix and every other
    action that would spend it say the same sentence, with the earliest date of what it needs.
    When the network itself refuses a coin that has not vested, it names only the date: "Part
    of this vests on <date>, and can be used from then. Nothing has moved." (without a date: "Part
    of this has not vested yet, and can be used once it has. Nothing has moved.")
  - "This receive code was paid already: ask for a new one. Nothing was sent."
  - "This payment was declined; nothing was sent."
  - "This wallet is out of date for this: update it, then try again. Nothing was taken." when
    the operator declines a payment or a settlement because the wallet needs updating.

- A confidential address (`tsqb1…`, a confidential receive code), paid on its own, is paid on the
  chain so that its amount is hidden (`confidential-pay.js`). A blinded output alone hides
  nothing when every other value is in the clear, so the payment comes with a second blinded
  output, to the wallet's own confidential address, which takes what the inputs hold beyond the
  payment and its fee; anyone reading the chain learns only the two together, and the wallet's
  share stays in its balance as a confidential coin.
  - What is held for instant payments is never confidential, and is paid out only in the clear.
    When the chain holds too little, the wallet first moves coins out to its own address, in an
    amount that does not give the payment away: all it holds of the asset there, or the smallest
    power of ten above what the payment needs (at least one whole unit), whichever is smaller
    (never less than the operator's smallest coin of the asset; of what the library can move now,
    when part of what is held cannot be, such as a channel's balance). It says "Moving <amount>
    <TICKER> out of the Ark so it can be sent confidentially. They are ready within <N> minutes.
    Keep this page open." (<N> as for a payment to an address, above) and the review opens once
    they are there, usually in about three minutes: one settlement of the operator's and its
    payout on the chain, and no confirmation more. A move
    already under way is waited for, never asked twice, so Review pressed again (the browser
    extension's popup closed and opened again) goes on waiting for it. When the move cannot be
    made, one of the sentences under "Stake, pools and Mix" says why and nothing moves; a coin
    just received that is still arriving is settled first, and the move goes on after it.
  - The asset is hidden only among the assets of the inputs. When the wallet holds a confidential
    coin of another asset (not the Sequence token, which may be staked), it is spent to the
    wallet's own confidential address in the same transaction, and the review says "Anyone
    reading the chain can see that a payment was made, but not its asset or amount."; otherwise
    "Anyone reading the chain can see that this payment is <TICKER>, but not how much."
  - When what the wallet holds leaves too little beside the payment to hide it (its fee margin
    or less), the payment is still offered, and the review says "This payment’s amount and asset
    can still be worked out by anyone reading the chain." So does the review of a payment with a
    confidential address among several recipients, which is built as any other.
  - BTC is never confidential: a `tsqb1…` address takes Sequentia assets only.

## Stake, pools and Mix

- A stake, a pool's delegation and a mix are made from coins the wallet holds on the chain, and
  default mode holds what it receives in the Ark. So the wallet moves what is missing out of the
  Ark to its own address by itself (never less than the operator's smallest coin of the asset),
  and says so while it waits: "Moving <amount> <TICKER> out of the Ark so it can be staked. They
  are ready within <N> minutes. Keep this page open." ("used to join the pool", "mixed"; Ambra
  mobile says "Keep this screen open."). Once it
  has arrived the usual review opens; nothing is signed before it.
- When the operator cannot pay that much on the chain now (its published `fundable`, against
  the whole coin the move gives), nothing is asked, so no coin waits: "<amount> <TICKER> cannot be
  moved out of the Ark right now: the network has too little of it free. Nothing has moved: try
  again later."
- A move already under way is waited for, never asked twice. One the operator cannot pay on the
  chain yet says "<amount> <TICKER> cannot be moved out of the Ark yet: the network moves it as
  soon as it can, and it stays yours meanwhile. …"; one that has not arrived within 45 minutes,
  "What was moved out of the Ark has not arrived yet. It stays yours: try again in a few minutes."
- Too little held: "Not enough <TICKER>: <amount> <TICKER> short." The 40,000 tSEQ minimum
  counts the fee only when the fee is paid in tSEQ: the stake card has **Pay the fee in**, and
  with too little tSEQ for both the wallet chooses another held asset there and says "Not enough
  tSEQ for the stake and its fee: the fee is paid in <TICKER> instead, chosen below. Press Review
  stake again."
- Mix says what is held of the asset, wherever it is held: "you hold <amount> <TICKER>".

## BTC

BTC is held on a Bitcoin ark: native bitcoin, never pegged, in a wallet of the same phrase, and
part of BTC's one figure. Its address there is part of the receive code. The words are in
`BTC_WORDS` (`btc-ark.js`).

- What the ark holds is kept within a band in USD (`ark-limits.js`, `SEQ_ARK_LIMITS`): it rests at
  1,500 USD, and once it holds 3,000 USD everything above 1,500 moves to the wallet's own address
  in one move, sized for its own fee so the ark then rests at 1,500, and counted in the figure
  throughout: the figure moves only by that fee. That move waits while a person
  reviews or makes a BTC payment and for a minute after, and one the ark's server refuses is tried
  again later each time (two minutes, then four, up to an hour). A payment of 1,500 USD or more is paid to the address, never into the ark: a payer
  using this wallet sends it there, and a receive code for such an amount carries neither an
  invoice nor the ark's address, nor does Receive's invoice card make one (below).
- BTC that arrives at the address and is confirmed moves into the ark by itself only while the
  ark holds less than a quarter of the resting level, in one move back up to it; the rest stays at
  the address, in the same BTC figure and sendable as ever. It is counted once in the figure while
  it moves (developer mode shows "<amount> BTC arriving" until it can be spent). Each move also
  keeps to the limits the ark's server publishes: at most its largest coin, the rest waiting at
  the address for the next move, and none below its least or before the server has said them.
- BTC a wallet holds where it cannot be sent in seconds (its own Lightning channel, in a wallet
  made before BTC was held this way) moves there by itself too, at most the ark's largest coin at
  a time, and stays spendable where it is until it has. Its channel, once emptied, is closed to the wallet's own address
  (`lightning-to-ark.js`; the same move for assets is under Balance).
- The wallet keeps what it holds there current by itself, and arranges each time it is open for
  that to go on while it is closed. Nothing is shown or asked. BTC kept current while the wallet
  was closed is "<amount> BTC arriving" for the moment it takes the wallet to take it in when it
  opens. A coin larger than the service takes now moves to the wallet's own Bitcoin address
  instead of being renewed, and back in from there, with nothing shown.
- When the service holding BTC for instant payments refuses to renew it or stops answering, and
  BTC there would need renewing within a day, the wallet moves it to its own Bitcoin address by
  itself, paying the Bitcoin network fees from that address. Only BTC worth more than the move
  costs goes. The line under the figure reads "The service holding <amount> BTC for instant
  payments stopped renewing it, so it is moving to your Bitcoin address. Bitcoin network fees:
  about <fee> BTC, paid from your Bitcoin address.", then "Moving <amount> BTC to your Bitcoin
  address, one Bitcoin block at a time.", and at the end "<amount> BTC arrived at your Bitcoin
  address, moved there because the service holding it for instant payments stopped renewing it.
  Bitcoin network fees: about <fee> BTC." While it moves, BTC arriving at the address stays there.
  When the address holds too little to pay the fees, the line says how much to receive there first;
  BTC worth less than its move says it stays and is renewed once the service answers again.
  Nothing else moves BTC this way in default mode; developer mode adds an **Exit…** button to the
  Bitcoin ark's part of BTC, which prices each coin and refuses one not worth its exit.
- **Receive BTC with an invoice**: "Make an invoice for BTC. Once it is paid, the BTC is yours in
  seconds." Then "Invoice ready. Share it to receive <amount> BTC." and, when paid, "Received ✓
  <amount> BTC." It makes no invoice the receive code would not carry: for 1,500 USD or more it
  says "A payment of 1,500 USD or more goes to the address. Give the receive code instead: it is
  paid there.", and for more than the operator's published limit on one payment received, "This
  can’t arrive in seconds right now. Give the receive code instead: it is paid at the address."
- Send, one BTC recipient: a receive code, an invoice or an address. The review is titled
  **Send <amount> BTC?** with To, Fee ("No fees" when none) and "It arrives in seconds." (for an
  address, "It arrives after a Bitcoin block."), and the button **Send**. When it is done: "Sent
  <amount> BTC (<seconds> s)." or "Sent <amount> BTC. It arrives after a Bitcoin block." With too
  little held this way, an address is paid as before; a code or an invoice is refused with "You
  can send up to <amount> BTC this way now." A payment the Bitcoin ark's server refuses is said in
  the wallet's words, never the server's: "Nothing was sent: this payment could not go out just
  now. Try again in a few minutes.", or, while the wallet's address holds BTC, "Nothing was sent:
  this payment could not go out just now. Your Bitcoin address holds <amount> BTC: a payment to an
  address of up to that goes from there." The faucet's BTC refused that way reads "The faucet could
  not send BTC just now. Try again in a few minutes."
- **Pay an invoice**: "Paste an invoice to pay it with your BTC." Then "Paid ✓ <amount> BTC · fee
  <fee> BTC." once the other side has taken it. While they hold it without taking it yet, "On its
  way: waiting for the other side to accept it."; if they never do, "Not paid: the payment came
  back, and the BTC is in your balance again." An invoice for anything else is refused with "This invoice asks for <TICKER>. Only
  invoices for BTC are paid here."; one larger than what is held this way with "You can pay up to
  <amount> BTC this way now."; one above the most one payment may move out in seconds (the
  operator's published limit) with "This invoice is more than can be paid in seconds now. Ask for a
  receive code or a Bitcoin address instead, and pay that from Send."
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
  rounding leaves, less than one atom of what is received); when a maker takes more only once
  what it received is settled (the share of the operator's bond it holds unsettled at once is
  spent for now): "The book can fill up to <amount> <TICKER> now, and more in a few minutes.", or,
  with nothing to fill until then, "<TICKER> for <TICKER> can be traded again in a few minutes." Review then shows the exact amounts
  and fees: what is paid can be a few atoms below what was typed, when the price leaves a
  remainder too small to buy anything, and that remainder stays in the wallet. Until Review, the
  amount that follows the price is an estimate and reads as one: "about" beside it. While Review
  asks for the exact price: "Getting the exact price…", and once that has taken longer than the
  sources are given to answer (eight seconds), while the wallet still checks a price it was
  given: "Still getting the exact price: this can take up to half a minute…". If the price
  moves: "The price moved. Here is the new one."
- **What the balance shows can always be traded or sent**, and so can a payment still on its way:
  its asset is offered under You pay (first when the wallet holds nothing else), the line under
  it reads "balance <amount> <TICKER> · <amount> <TICKER> arriving, in about a minute", Max
  fills both, and the trade settles it first. When part of what is paid waits only
  for the operator's next settlement (a coin too many payments from one to give part of, a
  payment still arriving, coins the wallet's own upkeep is settling, a coin of a format the other
  side's older build does not read), the wallet puts it through that settlement by itself, the
  button reads "Goes through in about a minute", and the price is asked again by itself once it
  is through. If that is found only at **Trade**, the trade is kept under Your trades as "Goes
  through in about a minute", with the price the person accepted as its bound: once through it
  is priced again and goes ahead by itself only at that price or better: it receives no less
  than the ticket showed, pays at most the price of one received atom more than the ticket
  showed (never more than the amount typed), and gets no less for what it pays than the
  ticket's price; otherwise
  "Returned: nothing traded. The price moved while it waited." A page closed or reloaded
  meanwhile finds the trade again and goes on with it, never twice, however many times the page
  follows it at once. Past ten minutes: "This is taking longer than usual. Nothing has moved: try again in a
  few minutes." Payments wait for that settlement the same way and then go. Coins too deep for
  part of them to be traded are settled by the wallet once it has been left alone two minutes,
  at a settlement's fee each, so the next trade from them goes at once.
- A trade whose other side cannot complete it after all (the other side says the offer is gone:
  the network refused it, for example because another device of the same wallet had already
  spent the coin it named) is not waited on: the wallet takes its coins back at once, learning
  what its other devices did, and prices the trade again under the same bound, the other side's
  new offer at the same price first. It goes ahead in the same row, still "Sent", only at the
  price the person accepted or better; otherwise "Returned: nothing traded. The price moved while
  it waited.", within seconds, or "Returned: nothing traded." when the other side's offers were gone
  three times. A trade the other side says it completed is waited on for two minutes more, then
  its coins are taken back as any trade's are.
- Fees are one line, each fee in the asset it is paid in: "Fees <amount> <TICKER>, included
  above", or "No fees". What the wallet pays to be able to receive (for BTC, the room it needs to
  take a payment) is counted as one of these fees and has no row of its own.
- **Trade** returns the screen at once: a card over it says **Trade sent**, with what is paid,
  what is received, the fees and the trade's status, which it follows until the trade ends
  (**Trade complete** or **Trade returned**); **Done** closes it and **View in history** opens
  History. A transaction the trade made on a chain is linked in that chain's explorer ("Transaction
  on Sequentia", "Transaction on Bitcoin"); a trade settled without one shows no link. Closed, the
  trade shows under **Open** as "Sending…" while its step is taken, and goes on there whether the
  person stays, leaves or closes the wallet; a row opens its card again. A trade that ends while
  its card is closed is said once wherever the person is, as "<what is paid> → <what is
  received>: <status>". What
  was entered, and a price being asked for, is kept when the wallet goes to the background, is
  locked or is reopened.
- Statuses, the same in Your trades, in History and on every surface: "Sending…", **Sent**,
  "Received, settling", then **Settled**. If a trade is undone: "Returned: nothing traded." or
  "Returned: nothing traded. Fees of <fees> were paid." A purchase with BTC whose other side's
  offer ran out while it waited, and was not renewed, says "Returned: nothing traded. The other
  side's offer ran out while the trade waited." A trade that settled and then never completed on
  the network is undone by itself: its row reads "Trade undone: <pay> for <get>" the moment the
  wallet learns the trade is dead, however long after it settled, with "Undone: this trade did
  not complete. What you paid is coming back to you, within about <N> hours." (the hours until it
  can be claimed home, as the wallet knows them; "within about two days" until it does). What it was to bring
  leaves the row and the figure; what was paid is in History as **Coming back**. Once it is home
  the row says "Undone: this trade did not complete. What you paid came back to you."
- Once its operator offers it, default mode trades only with its owner's exit on every checkpoint
  of the trade, so what a trade gives always comes home if the trade dies. An offer that cannot
  have it is left out of the prices ("Not offered right now…"); a trade refused for it when sent
  says "This trade isn't available right now. Nothing moved; try again in a few minutes." Before
  the operator first offers it, the wallet trades as it always has; once it has, the wallet keeps
  asking that operator for it, also when a later answer no longer offers it. Only the page's own
  operator, answering in default mode, sets this, and it holds for that operator alone.
- Every trade is instant at any size, what it brings is in the figure at once and can be traded
  on at once, and the wallet never leaves change of its own in a trade (it pays itself the exact
  amount first when it must). What a trade brought pays anything at once, over Lightning and to an
  address included, except the other side of a trade for BTC: that waits for the next settlement to
  make it the wallet's own, which the wallet asks for by itself, about a minute.

- Settling waits for the network, and no status promises how long: the only time a row shows is
  the minutes it has waited, once that is one or more. While it waits the row says what is
  already true: "Waiting for the other side. Nothing has left your wallet yet." (buying with BTC,
  until the asset is held for the wallet); "Sent (<N> min)"; "Paid. Your BTC is on its way."
  (selling for BTC, once the asset is paid); and once what the trade brings is held, "Received,
  settling (<N> min)", or after ten minutes still settling "Received, and yours to use. Settling
  with the network is taking longer than usual."
- Refusals: "This trade could not be made. Nothing moved."; "The other side declined. Nothing was
  traded."; "Not offered right now: nobody offers <get> for <pay> in one step."; "<get> for <pay>
  is not offered."; "Not offered right now: nobody offers anything for <pay>." (nothing can be
  chosen under You receive); "Enter how much you pay."; "That amount
  is too small to trade."; "You have no <pay> to trade." (only when none is held anywhere);
  "Your BTC is being moved so it can be traded. It is ready after <n> Bitcoin blocks. Nothing has
  moved yet." (BTC held at the wallet's address, none yet where a trade pays BTC from: the wallet
  moves what the trade needs by itself, at most what one move of the Bitcoin ark carries, and
  prices the trade again every 20 s), and on a ticket that pays only part of what was typed,
  "More of your BTC is being moved so it can be traded, ready after <n> Bitcoin blocks."; "Your <pay> is
  being redone after a Bitcoin reorganisation: it is still yours, and ready to trade again once
  that settles. Nothing has moved." (it could be traded, and a Bitcoin reorganisation took it
  back out of the chain); "Getting your <pay> ready for this trade: it is ready in a minute or two.
  Nothing has moved." (the offers are orders resting in the tree that only coins expiring later can
  fill: the wallet refreshes its older coins in the next round by itself, and prices the trade
  again while the person waits, taking the next order if that one went); "That is more than your
  <amount>." (more than the wallet holds, nothing of it on its way); "Your <pay> is held by an order
  you placed, and can be traded once it is filled or cancelled. Nothing has moved." (only a coin of
  an order the person placed); "Nobody could confirm a price for this just now. Nothing has moved: try again in a
  moment."; "Your wallet is still finishing something it started, so it could not get a price in
  time. Nothing has moved: try again in a moment." (no price within 45 seconds of Review while the
  wallet was busy, or a maker gave a price in time and the wallet was still checking it when the
  time ran out; a price that comes later is let go).
- A price comes within seconds: the best few offers are asked at once (the next few when none of
  them answers), and one that has not answered within eight seconds of being asked is left out of
  the price rather than waited for. What the wallet itself checks of a price it was given in time
  is waited for, up to half a minute more, while no other price is in hand.
- When a trade cannot be paid or received the way the wallet chose, the wallet takes the next
  route by itself. The person is never offered a button to pick one.
- The open tab, the pair and the amount typed are kept for the browser tab's session: a reload
  opens on them again. A ticket is not kept; Review asks for the price again.

## Market

Default mode is a trading screen, not only a form: once a pair is chosen, its market shows under
**You receive** and the trade's button, so the assets are picked before their market fills the
screen. The words are in `MARKET_WORDS` (`market-view.js`).

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
- Below the button and above the market, **Your trades**, in two groups: **Open** (trades still
  settling, with their status) and **Past**.
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

- **One list for everything**, newest first: payments and trades on either chain, what is paid and
  received in seconds, Lightning. No list per chain or per kind of payment.
- Above it, a filter for one asset ("All assets" by default) and **Refresh**. One asset shows
  every movement in it and every one that involves it: a swap of OILX for BTC shows under OILX and
  under BTC.
- **One row per payment or trade.** A trade is one row, however many legs it has.
- Beside each amount, its value in the currency chosen in "Show values in"; under them, the fee
  and its value. A value under one cent reads "<0.01 USD" (in the chosen currency). A payment out
  or a trade for which the wallet paid no fee says "zero fee", small and in italics.
- A trade's row is "Swapped <pay amount> <TICKER> for <get amount> <TICKER>", then a small line
  with the time and, while the trade is not settled, its status. On the right are
  "-<pay> <TICKER>" and "+<get> <TICKER>", then "fee <amount> <TICKER>" when there was one.
- A payment's row has its description (or "Received" / "Sent"), its time and its amount as +/-.
- A payment made while the wallet is moving that very money (its own refresh, already in its
  round) is not refused: it says "Your money is being moved: this goes ahead by itself (about a
  minute).", with the round's time as below, and goes ahead as soon as that round has ended, made
  final or dropped. Past that time it says "(taking longer than usual; the wallet keeps at it)".
- What is not in the figure yet is in History alone, each line with the time that is true for
  why it waits: **Arriving**, "about a minute", for a payment from someone else past what counts
  at once, or one a Bitcoin reorganisation took back (a round, final once its block is certified
  with its anchor buried under the operator's anchor depth: "about a minute" while that depth is
  0, else "usually within <N> minutes", a minute and ten for each Bitcoin block, rounded up to
  five); **Arriving**, "usually within <N> minutes",
  for a deposit to the address (Balance); **Coming back**, "about a minute", for what a channel
  being closed held; **Coming back**, "within about <N> hours" (from when it can be claimed home,
  once known; "within about two days" until then), for what an undone trade, or the wallet's
  safekeeping, is bringing home, whether or not this browser made the trade. Past that time the line says "taking longer than usual;
  the wallet keeps at it", and the wallet keeps at it. A received row, or a deposit's row on the
  chain, that is still arriving says so itself.
- A payment is in History the moment it leaves, and a payment arriving as soon as the network has
  it. This holds for what is paid and received in seconds too, and for every trade of the Trade
  tab: the wallet writes each down as it happens, in the browser that holds it, and shows them
  in the one list, by time, with what the chain holds. While it waits for a block, its time line ends with "Waiting for a Bitcoin block" (BTC) or
  "Pending", and that goes once it is confirmed.
- A payment to an address paid out of what the wallet holds for instant payments reads "Pending"
  until it is made. One that was not made reads "Not sent", with "Nothing left your wallet." and
  its amount struck through, and one taken back before it arrived reads "Did not arrive" (Send).
- A payment on either chain that has waited two blocks is sped up by the wallet itself (a small
  payment to itself that pays for both, `speed-up.js`), and again, paying more, each time it waits
  two more. Its row then reads "Taking longer than usual: the wallet paid a little more to speed it
  up." The speed-up has no row of its own. The same goes for what the wallet takes on the chain by
  itself, such as a coin moved out to keep it safe. Developer mode does nothing by itself: every
  waiting transaction offers **Speed up**, with the rate for both together, beside Bump fee and
  Replace on Sequentia.
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
- A site that only needs to know the wallet is yours (Emissio, to link a wallet to an account)
  asks it to sign a message instead, with no connection: **Connect your web wallet** on the site
  (**Connect your wallet** where it offers more than one), then in the wallet **Sign a message for
  <site>?**, "This proves the wallet is yours. It moves no coins.", the rows Site, Message (the
  exact text) and Signed by (the wallet's address), and **Approve** or **Reject**. The site says,
  while it waits, "Approve in your wallet."; when the web wallet is not open, it opens it and
  says "Your web wallet is opening in a new tab. Unlock it there, then press Connect again.";
  when the person rejects, "You declined in the wallet. Nothing was linked."; and when the wallet
  is locked, "Unlock your wallet, then press Connect again." The site keeps the Sign tab's way
  beside the button, for a wallet that is not in this browser.
- A site that builds its own transactions (Pignus, for loans) connects the same way ("Connect
  Pignus?", "Pignus wants to see your address and balances, and to ask you to sign what you
  borrow, lend and repay there. Each transaction is shown here for you to approve."). Each
  transaction then shows **Sign a transaction for <site>?**, "<site> built this transaction. This
  is what it does to your wallet; approve it only if it is what you asked for there.", the rows
  **You pay**, **You receive**, **Network fee** and **Asked by**, and **Approve** or **Reject**.
  When it needs coins on the chain that the wallet holds in the Ark, it first asks **Get coins
  ready for <site>?**, "<site> needs coins on the chain for what you asked there. The wallet moves
  them to your own address; they stay yours, and only the fee for the move is paid.", with
  **Moves**, **Fee for the move** and **Asked by**; once approved, the wallet says "Moving
  <amount> <TICKER> out of the Ark so it can be used on <site>." while it waits, as Stake does.

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
submarine, LSP, bridge, gateway, on-chain, Lightning, claim, distribution, lapse, locktime, parent
chain, input, vB. Nor do these controls: a choice of rail, a
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
