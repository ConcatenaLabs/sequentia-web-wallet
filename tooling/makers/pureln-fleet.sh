#!/usr/bin/env bash
# Pure-LN maker fleet: six assets on both sides against BTC, and every
# asset/asset pair on both sides, eight price levels each. Run by
# seqob-pureln-fleet.service. Each launch of a maker reads the feed again: a
# maker retires its offer at expiry (an hour) and is relaunched at the price of
# that moment, so the fleet follows the market hour by hour. A maker requotes
# its own remainder after a partial fill. Identities are stable per (pair,
# side, level), box-local, never in git.
#
# Installed on the box as /root/seqob-test/pureln-fleet.sh, a link to this file.
#
# Every level is its OWN process because pure-LN keeps ONE swap in flight per
# maker, so every rung shown is a rung a taker can actually lift.
BIN=/root/sequentia/seqdex/bin/seqob-maker
ASOCK=/root/sequentia/lsp/ln-asset/sequentia-testnet/lightning-rpc
BSOCK=/root/sequentia/lsp/btc-maker/testnet4/lightning-rpc
RELAY=http://127.0.0.1:9965
FEED=http://127.0.0.1:8080/prices
KEYS=/etc/sequentia/maker-keys
LOGS=/root/seqob-test/run

# The feed again, for a maker being (re)launched; the last answer stands when it
# does not answer.
refresh_prices() { local p; p=$(curl -sf -m 10 "$FEED") && PRICES=$p; }

# The price of a ticker, or 0 when the feed does not carry it.
px() { echo "$PRICES" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get(\"$1\") or d.get(\"t$1\") or 0; print(v[\"price\"] if isinstance(v,dict) else v)" 2>/dev/null; }
is_positive() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0 else 1)" "$1" 2>/dev/null; }
is_atoms() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }

# The feed is another service and starts on its own schedule: at boot this
# script can run before it listens. Every amount below is derived from it, and
# a maker launched with an empty amount is refused by its own flag parser,
# prints its whole usage text and gets relaunched for ever. So nothing starts
# until the feed has answered with a BTC price.
until PRICES=$(curl -sf -m 10 "$FEED") && BTCP=$(px BTC) && is_positive "$BTCP"; do
  echo "price feed $FEED has not answered with a BTC price; retrying in 5s" >&2
  sleep 5
done

# Keep one maker running for as long as the service lives. A maker that ran for
# a minute is relaunched after 8s. One that exits sooner is failing on
# something a relaunch does not change at once (a Lightning node that is down,
# the relay restarting), so each quick exit doubles the wait, up to 5 minutes,
# and a run that lasts resets it.
keep_running() { # logfile command...
  local log=$1 delay=8 started rc ran
  shift
  while true; do
    started=$SECONDS
    "$@" >> "$log" 2>&1
    rc=$?
    ran=$((SECONDS - started))
    if [ "$ran" -ge 60 ]; then
      delay=8
    else
      delay=$((delay * 2))
      [ "$delay" -gt 300 ] && delay=300
    fi
    echo "[fleet] $(date -u +%FT%TZ) exited rc=$rc after ${ran}s; relaunch in ${delay}s" >> "$log"
    sleep "$delay"
  done
}

maker_key() { # name -> path of its key file, created on first use
  local key=$KEYS/$1.key
  [ -f "$key" ] || { head -c32 /dev/urandom | xxd -p -c64 > "$key"; chmod 600 "$key"; }
  echo "$key"
}

# One price level of an asset against BTC, priced now: the quote is the feed's
# value of THIS level's size, then moved away from the touch by the level's
# offset. Pricing the first level's size and then growing the size left every
# deeper level selling 1.5x to 5x more of the asset for the same bitcoin: 30%
# to 80% under the market on 21/10/2026.
price_btc() { # ticker side base_atoms level -> "BASE QUOTE", or nothing
  local T=$1 S=$2 BASE=$3 LVL=$4 AP BTCP
  refresh_prices
  AP=$(px $T); BTCP=$(px BTC)
  is_positive "$AP" && is_positive "$BTCP" || return 1
  python3 - "$S" "$BASE" "$LVL" "$AP" "$BTCP" <<'PY'
import math, sys
s, base, lvl, ap, btcp = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
# Ladder: 20 bps at the touch, +25 bps per level out, sizes growing 1.5x per
# level capped at 5x: the shape of an actively traded book, dense near the
# touch with real size building behind it.
base = int(base * min(5, 1.5 ** (lvl - 1)))
off = 0.002 + (lvl - 1) * 0.0025
fair = max(200, math.ceil(base / 1e8 * ap / btcp * 1e8))
print(base, int(fair * (1 - off)) if s == 'buy' else int(fair * (1 + off)))
PY
}
launch_btc() { # ticker assetid side base_atoms level name
  local T=$1 A=$2 S=$3 B0=$4 LVL=$5 NAME=$6 AMTS BASE QUOTE
  AMTS=$(price_btc $T $S $B0 $LVL) || { echo "$NAME: the feed has no price for $T or BTC; retrying"; return 1; }
  read -r BASE QUOTE <<< "$AMTS"
  is_atoms "$BASE" && is_atoms "$QUOTE" || { echo "$NAME: amounts '$BASE'/'$QUOTE' are not whole atoms"; return 1; }
  $BIN -mode pureln -side $S -base $A -base-amount $BASE -quote-amount $QUOTE     -asset-ln-socket $ASOCK -ln-socket $BSOCK -btc-asset "" -relay $RELAY     -hold-timeout 3m0s -maker-priv "$(cat "$(maker_key $NAME)")" -logtostderr
}
run_maker() { # ticker assetid side base_atoms level(1..8), against BTC
  local T=$1 A=$2 S=$3 BASE=$4 LVL=${5:-1}
  local NAME=pureln-$T-$S-$LVL
  is_positive "$(px $T)" || { echo "$NAME: the feed has no price for $T; not started" >&2; return; }
  keep_running "$LOGS/$NAME.log" launch_btc $T $A $S $BASE $LVL $NAME &
}

# Asset/asset pure-LN pairs: both legs on ln-asset, the quote priced in the
# quote asset's own atoms from the same feed, and for the same reason after the
# level's size.
price_aa() { # baseT quoteT side base_atoms level -> "BASE QUOTE", or nothing
  local BT=$1 QT=$2 S=$3 BASE=$4 LVL=$5 BP QP
  refresh_prices
  BP=$(px $BT); QP=$(px $QT)
  is_positive "$BP" && is_positive "$QP" || return 1
  python3 - "$S" "$BASE" "$LVL" "$BP" "$QP" <<'PY'
import math, sys
s, base, lvl, bp, qp = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
# Same ladder shape as the BTC pairs, 40 bps at the touch.
base = int(base * min(5, 1.5 ** (lvl - 1)))
off = 0.004 + (lvl - 1) * 0.0025
fair = max(1000, math.ceil(base * bp / qp))
print(base, int(fair * (1 - off)) if s == 'buy' else int(fair * (1 + off)))
PY
}
launch_aa() { # baseT baseId quoteT quoteId side base_atoms level name
  local BT=$1 BA=$2 QT=$3 QA=$4 S=$5 B0=$6 LVL=$7 NAME=$8 AMTS BASE QUOTE
  AMTS=$(price_aa $BT $QT $S $B0 $LVL) || { echo "$NAME: the feed has no price for $BT or $QT; retrying"; return 1; }
  read -r BASE QUOTE <<< "$AMTS"
  is_atoms "$BASE" && is_atoms "$QUOTE" || { echo "$NAME: amounts '$BASE'/'$QUOTE' are not whole atoms"; return 1; }
  $BIN -mode pureln -side $S -base $BA -base-amount $BASE -quote-amount $QUOTE     -quote-asset $QA -asset-ln-socket $ASOCK -ln-socket $ASOCK -relay $RELAY     -hold-timeout 3m0s -maker-priv "$(cat "$(maker_key $NAME)")" -logtostderr
}
run_aa() { # baseT baseId base_atoms quoteT quoteId side level(1..8)
  local BT=$1 BA=$2 BASE=$3 QT=$4 QA=$5 S=$6 LVL=${7:-1}
  local NAME=pureln-$BT$QT-$S-$LVL
  is_positive "$(px $BT)" && is_positive "$(px $QT)" || { echo "$NAME: the feed has no price for $BT or $QT; not started" >&2; return; }
  keep_running "$LOGS/$NAME.log" launch_aa $BT $BA $QT $QA $S $BASE $LVL $NAME &
}

TSEQ=c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40
USDX=2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de
EURX=e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13
SILVR=57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48
OILX=4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f
GOLD=3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1

for spec in "GOLD $GOLD 20000" "SEQ $TSEQ 2000000000" "USDX $USDX 50000000" "EURX $EURX 200000000" "SILVR $SILVR 50000000" "OILX $OILX 2000000"; do
  set -- $spec
  for LVL in 1 2 3 4 5 6 7 8; do
    run_maker $1 $2 sell $3 $LVL
    run_maker $1 $2 buy $3 $LVL
  done
done

# Every asset/asset pair, both sides, offered the way round the wallet reads it.
# The wallet prices a pair one way (swap.js canonicalPair): USDX, then EURX,
# are the quote; between two other assets the lower asset id is the base. A
# book offered the other way round is a book the wallet never reads: SILVR/OILX
# had sixteen offers resting while the wallet asked OILX/SILVR and found none.
qrank() { case $1 in USDX) echo 900;; EURX) echo 890;; *) echo 400;; esac; }
# Level 1's size of an asset when it is the base, in its own atoms
# (conservative against hub channel capacity).
aa_size() { case $1 in SEQ) echo 1000000000;; USDX) echo 20000000;; EURX) echo 100000000;; GOLD) echo 20000;; SILVR) echo 20000000;; OILX) echo 2000000;; esac; }
run_pair() { # tickerA idA tickerB idB side level
  local A=$1 AI=$2 B=$3 BI=$4 S=$5 L=$6 ra rb
  ra=$(qrank "$A"); rb=$(qrank "$B")
  if [ "$ra" -gt "$rb" ] || { [ "$ra" -eq "$rb" ] && [[ "$AI" > "$BI" ]]; }; then
    run_aa "$B" "$BI" "$(aa_size "$B")" "$A" "$AI" "$S" "$L"
  else
    run_aa "$A" "$AI" "$(aa_size "$A")" "$B" "$BI" "$S" "$L"
  fi
}
export LC_ALL=C   # asset ids compare byte by byte, as the wallet compares them
ASSETS=("SEQ $TSEQ" "USDX $USDX" "EURX $EURX" "GOLD $GOLD" "SILVR $SILVR" "OILX $OILX")
for S in sell buy; do
 for LVL in 1 2 3 4 5 6 7 8; do
  for ((i = 0; i < ${#ASSETS[@]}; i++)); do
   for ((j = i + 1; j < ${#ASSETS[@]}; j++)); do
    run_pair ${ASSETS[i]} ${ASSETS[j]} $S $LVL
   done
  done
 done
done
wait
