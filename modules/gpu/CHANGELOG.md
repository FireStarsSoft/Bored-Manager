# Changelog

All notable changes to the NVIDIA GPU module. Versions are independent of the app's.

## 2.1.0

- The auto power cap works per GPU instead of on one index typed into a box. The **Auto power cap** page lists every GPU the machine reports; opening a row offers its two caps, prefilled with the minimum and maximum that GPU allows.
- Watts are checked against the range the driver reports before anything is run. An empty number field used to arrive as `0` and be sent to `nvidia-smi` as `-pl 0`; it is now refused with the allowed range in the message. The same check guards setting a limit by hand.
- What to watch is saved per machine, so it survives a reconnect, an app restart and a reboot. It used to live only in memory, which meant a watcher that had already changed a cap forgot it was supposed to change it back.
- Busy can now mean "a compute process is on that GPU" (`nvidia-smi`) instead of only "a container is running somewhere on the machine" (`docker ps`).
- The GPU table gained the minimum, maximum and default power limits (`power.min_limit`, `power.max_limit`, `power.default_limit`) and the current draw; the watcher's log is shown on the page instead of being collected and thrown away.
- Methods: `autoCapStart` no longer takes arguments (it resumes what is saved). New `autoCapSet`, `autoCapClear`, `autoCapConfigure` and `autoCapLogTail`.
- Pages with no GPU say what to check instead of showing a card with nothing in it.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Dashboard + Auto power cap) and `ui/widgets/*.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The page, the charts, the controls and the auto power cap behave as before.
- Killing a compute process now runs `kill -KILL` from this module instead of going through the Processes feature, so the GPU page keeps working when the Processes module is disabled or uninstalled.
- The two Overview widgets are enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules.
