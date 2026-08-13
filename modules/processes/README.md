# Processes

The process table: what is running, what it costs, and the two things you want to do about it.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Processes** page — a system detail strip (per-core CPU, memory and swap, and optionally file systems and temperatures), then a sortable and filterable table of up to 400 processes with kill and renice |

This module contributes no Overview widget. The **Top processes** card on the Overview is the app's own, fed by the core top-consumers collector, so it stays whether this module is installed or not.

## What it runs on the target

The table is pulled while the page is open, not collected in the background:

```sh
ps axo pid,user:20,pcpu,pmem,rss,stat,etime,comm,args --sort=-pcpu --no-headers | head -n 400
kill -TERM <pid> / kill -KILL <pid>      # elevated only when a plain kill is denied
renice -n <n> -p <pid>                   # always elevated
```

## Optional panels

Two panels of the detail strip show data other modules collect:

| Panel | Needs | Without it |
|---|---|---|
| File systems | the **Disk** module | the panel is not rendered |
| Sensors | the **Sensors** module | the panel is not rendered |

They are read off the shared module bus by stream name — this module does not import from either one, so it never breaks when they are disabled or uninstalled.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Processes** (fast) | how often the table refreshes while the page is open; `paused` means manual refresh only |

## Files

```
main/index.ts     activate(): registers list / kill / renice, no poller
main/service.ts   the ps command, its parser and the two actions
renderer/index.tsx     tab declaration
renderer/api.ts        typed wrappers over the module's own IPC methods
renderer/ProcessesTab.tsx
```
