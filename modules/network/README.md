# Network

The most detailed page in the app: not just how much traffic there is, but which socket and which process it belongs to, in which direction.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Network** page — Download/Upload widgets with session totals, a per-interface traffic chart, interfaces table, full connections table, bandwidth per process, listening ports, TCP quality, gateway and DNS |
| History | writes the `network` metrics stream (total rates and connection count) |

This module contributes no Overview widget. The **Network** card on the Overview is the app's own, fed by the machine-wide rates in the core system stream, so it keeps working when this module is disabled.

## What it runs on the target

Every tick, in one shell roundtrip:

```sh
cat /proc/net/dev        # per-interface byte, packet, error and drop counters
ss -Htunapi              # every socket, its owner and its byte counters
cat /proc/net/snmp       # TCP retransmits, segment and datagram counters
```

Only when the cached inventory is older than the slow interval, appended to the same roundtrip:

```sh
ip -j addr               # addresses and MTU
/sys/class/net/*         # operstate, link speed, MAC, MTU
ip -j route show default # gateway
cat /etc/resolv.conf     # DNS servers
```

`ss -i` is what makes per-socket accounting possible: `bytes_acked` and `bytes_received` are kernel counters, so diffing them between ticks yields per-connection and per-process rates without installing anything. The kernel exposes no such counters for UDP, so UDP rows show a rate of `—`.

## Sudo

Without root, `ss` only shows the owning process for *your own* sockets. The page shows a warning badge while it is running with limited visibility. The app elevates automatically when a sudo password was given at connect time.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Network** (fast) | how often counters and sockets are read |
| Update intervals → **Network** (slow) | how often addresses, MTU, link speed, gateway and DNS are re-read; `Manual only` reads them once |
| Data collection → **Network connections** | `While tab is open` (default), `Always` (keeps per-process session totals accurate in the background) or `Off` |
| Data & storage | whether the `network` history stream is written, and for how long |

Note that the per-interface chart can only reach as far back as the live buffer (10 minutes): the stored history keeps machine-wide totals, not one series per interface.

## Files

```
main/index.ts     activate(): one poller with a fast and a cached-slow part
main/service.ts   the probes, the counter diffing and session accounting
renderer/index.tsx     tab + stream declarations
renderer/api.ts        typed wrapper over the module's own kill method
renderer/NetworkTab.tsx
```

The `ss` parser itself lives in `shared/ss.ts`, because the app's own top-consumers collector uses it too.
