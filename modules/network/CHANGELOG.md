# Changelog

All notable changes to the Network module. Versions are independent of the app's.

## 3.0.1

- Coalesces the Host tuning page's duplicate `netTunables` reads into one target probe per refresh interval, instead of running the same `/proc/sys`, neighbour and conntrack command once for every bound field.

## 3.0.0

- New **Host tuning** page: the kernel limits that decide how many containers a machine can actually hold — the neighbour (ARP) table, file descriptors, inotify watches, conntrack and the queue sizes — shown next to how close the machine is to each one.
- **Scale for N container addresses**: enter how many addresses you are planning for and the page works out what each limit would have to be. Every proposal only ever raises a value, so a machine already tuned higher keeps what it has.
- Values can also be set one at a time, with the checks that matter: the three neighbour thresholds have to increase, `fs.file-max` should be at least twice what is open, `nf_conntrack_max` at least twice what is tracked, and the local port range has to be a valid `low high` pair.
- Anything applied goes to the running kernel with `sysctl -w` **and** to `/etc/sysctl.d/99-bored-manager.conf`, which this module owns and rewrites in full — so the page can show what is merely live against what will survive a reboot.
- How high a value may be set is itself configurable, on the same page, for a machine that genuinely needs more than the defaults allow.
- Without sudo the page is read-only and says so up front.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Traffic + Connections). The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The probes, the tables and the charts are unchanged.
- Killing the process behind a connection now runs `kill -TERM` from this module instead of going through the Processes feature, so the page keeps working when the Processes module is disabled or uninstalled.
- The whole module can be disabled or uninstalled in Settings → Modules. The Overview's Network card is unaffected - it belongs to the app and is fed by the core system stream.
