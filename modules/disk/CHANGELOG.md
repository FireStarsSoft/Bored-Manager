# Changelog

All notable changes to the Disk & storage module. Versions are independent of the app's.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Devices + File systems) and `ui/widgets/filesystems.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The probes, the tables and the two-speed polling are unchanged.
- The storage reading (df, inodes, lsblk) no longer has a separate "File systems" collector switch: it runs whenever this module is enabled, and the module itself is the switch.
- The File systems Overview widget is enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules. The Overview's Disk I/O card is unaffected - it belongs to the app.
