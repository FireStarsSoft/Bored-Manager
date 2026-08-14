# Network

The most detailed page in the app: not just how much traffic there is, but which socket and which process it belongs to, in which direction.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Traffic** and **Connections** — Download/Upload widgets with session totals, a per-interface traffic chart, interfaces table, full connections table, bandwidth per process, listening ports, TCP quality, gateway and DNS |
| Sidebar | **Host tuning** — the kernel limits that cap how many containers a machine can hold, and how close it is to each one |
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

## Host tuning

Four limits fail the same unhelpful way when a machine runs out of them — something stops resolving, or opening, or watching — and all four are what actually caps how many containers a host can hold:

| Limit | Runs out when |
|---|---|
| `net.*.neigh.default.gc_thresh1/2/3` | many containers share the LAN (ipvlan, macvlan, a bridged Incus network) and the kernel starts evicting neighbour entries |
| `fs.file-max`, `fs.nr_open` | many processes each hold sockets and files |
| `fs.inotify.max_user_watches/instances` | anything watches a large tree; the limit is per *user*, not per process, and each watch costs about 1 KB of kernel memory |
| `net.netfilter.nf_conntrack_max` | a busy NAT or bridge network fills the connection tracking table |

**Scale for N container addresses** turns a number of planned addresses into a value for each of them. Every formula is `max(current, …)`, so a machine already tuned higher is never pulled back down by asking the question. You can also set values one at a time, with the cross-checks that matter: the three neighbour thresholds have to increase, `fs.file-max` should be at least twice what is open, `nf_conntrack_max` at least twice what is tracked, and the local port range has to be a valid `low high` pair.

Anything applied goes to the running kernel with `sysctl -w` **and** to `/etc/sysctl.d/99-bored-manager.conf`, which this module owns and rewrites in full from what was already persisted plus what just changed — so the page can show what is merely live against what will survive a reboot. Nothing else should edit that file.

A systemd unit does not get the kernel's descriptor limit; `DefaultLimitNOFILE` in `/etc/systemd/system.conf` (or `LimitNOFILE` on the unit) decides that. The page says so when you touch the descriptor limits, but does not write it.

## Sudo

Without root, `ss` only shows the owning process for *your own* sockets. The page shows a warning badge while it is running with limited visibility. The app elevates automatically when a sudo password was given at connect time.

Host tuning needs sudo to change anything. Without it the page still reads every value — `/proc/sys` is world-readable — but says up front that it is read-only.

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
main/tunables.ts  reading the kernel limits, planning them, writing them
main/rules.ts     how high this module will let a limit be set
```

The `ss` parser itself lives in `shared/ss.ts`, because the app's own top-consumers collector uses it too.
