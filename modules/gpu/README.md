# NVIDIA GPU

Everything `nvidia-smi` reports, as charts instead of a table, plus the controls that need root.

## What it adds

| Where | What |
|---|---|
| Sidebar | **GPU** page — utilisation, VRAM, temperature and power charts; power limit slider, persistence switch, clock lock/reset; Auto power cap; compute process table with kill |
| Overview | **GPU** widget (on by default) — utilisation with VRAM, temperature and power in the subtitle, and the processes holding VRAM |
| Overview | **GPU processes** widget (off by default) — PID, name and VRAM per compute process |
| History | writes the `gpu` metrics stream (utilisation, VRAM, temperature, draw, limit) so charts longer than 10 minutes work |

## What it runs on the target

One command per tick, three queries in the same shell:

```sh
nvidia-smi --query-gpu=... --format=csv,noheader,nounits
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory ...
nvidia-smi --query-gpu=index,gpu_uuid ...          # maps a process to its GPU
```

The controls each run one elevated command: `nvidia-smi -pl`, `-pm`, `-lgc`, `-rgc`, and `kill -KILL` for the process table. Without a sudo password they are disabled and the page says so.

## Auto power cap

An in-app watcher: every *interval* seconds it asks `docker ps -q` whether anything is running and applies the *running* or *idle* cap accordingly. It runs inside the app and stops when the app closes or the module is disabled — nothing is installed or left behind on the target.

Note that it only needs the Docker *daemon* on the target, not the Docker module in this app.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **GPU** (fast) | how often the metrics are polled; `paused` stops the poller |
| Overview → **GPU**, **GPU processes** | which widgets are shown |
| Data & storage | whether the `gpu` history stream is written, and for how long |

## When it shows nothing

`nvidia-smi` missing or no NVIDIA card: the page says "No NVIDIA GPU detected" and the Overview widget reads `N/A`. AMD and Intel GPUs are not covered — a module of their own could add them.

## Files

```
main/index.ts     activate(): one fast poller + the nvidia-smi actions
main/service.ts   polling, parsing, controls, the auto power cap watcher
renderer/index.tsx     tab + widgets + stream declarations
renderer/api.ts        typed wrappers over the module's own IPC methods
renderer/GpuTab.tsx
renderer/GpuCards.tsx
```
