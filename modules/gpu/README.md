# GPU

Everything `nvidia-smi` reports, as charts instead of a table, plus the controls that need root.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Dashboard** — utilisation, VRAM, temperature and power charts, and the compute process table with kill |
| Sidebar | **Auto power cap** — every GPU the machine reports, with its allowed range, plus the watcher below |
| Overview | **GPU utilisation** widget (on by default) — utilisation and temperature on one dual-axis chart |
| Overview | **GPU power** widget (on by default) — power draw and the current cap, the same series as the Dashboard Power chart |
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

The **Auto power cap** page lists the GPUs `nvidia-smi` reports on the connected machine, with the cap each one has now and the minimum, maximum and default the driver allows. Open a row and the two cap fields start at that GPU's own minimum and maximum, so the numbers are never guessed — a value outside the range is refused with the range in the message, rather than sent to `nvidia-smi` to fail.

Every *interval* seconds the watcher asks whether the machine is busy and puts the *running* or the *idle* cap on each GPU it was given. Busy means one of two things, your choice:

| Trigger | What it asks | Scope |
|---|---|---|
| `docker` | `docker ps -q` — is any container running | the whole machine |
| `gpu` | `nvidia-smi --query-compute-apps` — is a compute process on **that** GPU | per GPU |

The `docker` trigger only needs the Docker *daemon* on the target, not the Container module in this app.

What to watch is saved per machine (`ctx.hostDataSet`, in `data/module-data/gpu/<host>.json`), so reconnecting, restarting the app or rebooting the server picks it back up. That is deliberate: the cap itself lives on the GPU, so a watcher that forgot its settings would leave whichever cap it happened to set last in place. Nothing is installed or left behind on the target — stop watching and the GPU simply keeps the cap it has.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **GPU** (fast) | how often the metrics are polled; `paused` stops the poller |
| Overview → **GPU utilisation**, **GPU power**, **GPU processes** | which widgets are shown |
| Data & storage | whether the `gpu` history stream is written, and for how long |

## When it shows nothing

`nvidia-smi` missing or no NVIDIA card: the page says "No GPU detected" and the Overview widgets say the same. AMD and Intel GPUs are not covered — a module of their own could add them.

## Files

```
main/index.ts          activate(): one fast poller + the nvidia-smi actions
main/service.ts        polling, parsing, controls, the auto power cap watcher
ui/pages/dashboard.json
ui/pages/power.json    the GPU table and the watcher
ui/widgets/summary.json
ui/widgets/power.json
ui/widgets/processes.json
```
