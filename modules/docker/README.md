# Docker

The containers on the target machine, what they cost, and enough of `docker inspect` to explain why one of them is unhappy.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Docker** page — a summary strip, a containers table (status, healthcheck, CPU and memory bars, network ↓/↑, block read/write, PIDs, published ports), a per-container detail panel, then images, volumes and networks |
| Overview | **Docker** widget (on by default) — running/stopped, Σ CPU, and the images/volumes footprint |
| Overview | **Docker resources** widget (off by default) — counts, sizes and what a prune would reclaim |
| History | writes the `docker` metrics stream (running count, Σ CPU, Σ memory) |

## Opening a container

Clicking a row opens a panel with its own CPU and memory chart (picked out of the last five minutes of snapshots the module already holds — no extra daemon call), exit code, restart count and policy, healthcheck result including the last probe output, created/started/stopped times, command, compose project, published ports, networks with their addresses and every mount. Plus **logs** (`docker logs -f`, streamed live), an **exec shell** and pause/unpause.

The exec shell is opened through the app's Terminals page, so it is registered in the session and closed with everything else.

## What it runs on the target

Fast tick, one roundtrip:

```sh
docker ps -a --format '{{json .}}'
docker stats --no-stream --format '{{json .}}'
```

Slow tick:

```sh
docker system df --format '{{json .}}'
# falls back to counting images / volumes / containers when df is unavailable
```

On demand: `docker images|volume ls|network ls`, `docker inspect`, `docker logs -f`, and one command per action (`start`, `stop`, `restart`, `kill`, `pause`, `unpause`, `rm -f`, `rmi`, `image|volume|network prune -f`). Every id is validated against a strict pattern and shell-quoted before it reaches a command line.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Docker** (fast) | how often containers and their stats are read |
| Update intervals → **Docker** (slow) | how often disk usage is read; `Manual only` reads it once and then only on request |
| Overview → **Docker**, **Docker resources** | which widgets are shown |
| Data & storage | whether the `docker` history stream is written, and for how long |

## When it shows nothing

No Docker daemon, or the connecting user is not in the `docker` group: the page and the widget both say Docker is not available. Note that the GPU module's auto power cap watches `docker ps` itself and does not need this module.

## Files

```
main/index.ts     activate(): a fast poller, a slow one, and the actions
main/service.ts   the probes, the parsers, inspect, the actions, log streaming
renderer/index.tsx     tab + widgets + stream declarations
renderer/api.ts        typed wrappers over the module's own IPC methods
renderer/DockerTab.tsx
renderer/DockerCards.tsx
```
