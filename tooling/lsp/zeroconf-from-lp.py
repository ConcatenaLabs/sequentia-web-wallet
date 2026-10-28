#!/usr/bin/env python3
"""Accept a zero-confirmation channel from one peer: the service's own liquidity node.

A hosted Bitcoin node takes a channel only once its funding has a block (`funding-confirms=1`),
so room to receive BTC that the service opens during a trade was usable only after a testnet4
block, ten minutes or more. With this plugin the node answers the `openchannel` hook with
`mindepth: 0` for the one peer named by `zeroconf-peer` (the LSP's BTC LP), and the channel is
usable in seconds. Every other peer is left to the node's own rules, so a stranger's channel still
waits for its block, and a stranger asking for zero-conf is refused by lightningd itself.

What the node trusts by it: that the service will not double-spend the funding of a channel the
service opened, until that funding has a block. The coins in such a channel are the service's
until the node is paid over it.

Standard library only: it speaks the plugin protocol on stdin/stdout itself, so it needs no
pyln-client on the host. It is dynamic, so the LSP can start it on a running node
(`plugin start <path> zeroconf-peer=<id>`) as well as through the node's config.
"""
import json
import sys

PEER = {"id": ""}


def manifest():
    return {
        "options": [{
            "name": "zeroconf-peer",
            "type": "string",
            "default": "",
            "description": "node id whose channels this node accepts without a confirmation",
        }],
        "rpcmethods": [],
        "hooks": [{"name": "openchannel"}],
        "subscriptions": [],
        "dynamic": True,
    }


def openchannel(params):
    oc = (params or {}).get("openchannel") or {}
    peer = str(oc.get("id") or "").lower()
    if PEER["id"] and peer == PEER["id"]:
        return {"result": "continue", "mindepth": 0}
    return {"result": "continue"}


def handle(msg):
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "getmanifest":
        return manifest()
    if method == "init":
        opt = (params.get("options") or {}).get("zeroconf-peer") or ""
        PEER["id"] = str(opt).strip().lower()
        return {}
    if method == "openchannel":
        return openchannel(params)
    return None


def main():
    dec = json.JSONDecoder()
    buf = ""
    out = sys.stdout
    while True:
        chunk = sys.stdin.readline()
        if not chunk:
            return
        buf += chunk
        while True:
            s = buf.lstrip()
            if not s:
                buf = ""
                break
            try:
                msg, end = dec.raw_decode(s)
            except ValueError:
                break
            buf = s[end:]
            if not isinstance(msg, dict) or "id" not in msg:
                continue   # a notification: none is subscribed
            result = handle(msg)
            if result is None:
                reply = {"jsonrpc": "2.0", "id": msg["id"],
                         "error": {"code": -32601, "message": "unknown method %s" % msg.get("method")}}
            else:
                reply = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
            out.write(json.dumps(reply) + "\n\n")
            out.flush()


if __name__ == "__main__":
    main()
