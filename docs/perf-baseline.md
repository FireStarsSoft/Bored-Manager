# Resource baseline

Measured on 2026-08-22 before the resource-optimisation work, at commit
`0a97dd150a467626a3a9778b32f7adf7562f648a`.

## Environment

- WSL2 Linux 6.18.33.2, x86-64
- Node.js 20.20.2
- Bored Manager 0.3.2 production build
- One local target, normal 2-second refresh
- Temporary application root and data directory under `/tmp`; no project or
  user data was used

The Windows checkout only contained the Windows esbuild binary. To keep this
pre-change measurement reproducible without installing another project
dependency, module runtimes were disabled and this baseline covers the core
`system`, `top`, and `services` collectors. Module command reductions are
verified separately by executor-counting tests.

The Cursor test harness opens one WebSocket when it detects the temporary
server. Scenario A therefore sets `detailPolling.overviewTop` to `off`, which
is equivalent to having no active Overview tab for the core collectors.

## Results

### A. No active data page

- Active pollers: `system-metrics:local`, `core:services`
- System-wide process creations over 60 seconds: **214**
- Server CPU samples (30-second spacing): **0.3%, 0.3%, 0.2%, 0.2%, 0.2%**
  (mean **0.24%**)
- Server RSS samples: **77,440; 77,808; 77,752; 77,680; 77,620 KiB**
  (mean **77,660 KiB**)
- App self snapshot: **0.13% CPU**, **76,492,800 bytes RSS**
- Last system tick: **6 ms** (**0.30%** estimated interval cost)

### B. Overview active

- Active pollers: `system-metrics:local`, `top-consumers:local`,
  `core:services`
- System-wide process creations over 60 seconds: **276**
- Server CPU samples (30-second spacing): **0.4%, 0.4%, 0.3%, 0.3%, 0.3%**
  (mean **0.34%**)
- Server RSS samples: **76,308; 76,060; 76,644; 76,940; 77,944 KiB**
  (mean **76,779 KiB**)
- App self snapshot: **0.13% CPU**, **77,471,744 bytes RSS**
- Last system tick: **5 ms** (**0.25%** estimated interval cost)
- Last top tick: **4 ms** (**0.20%** estimated interval cost)

## Interpretation

`/proc/stat`'s `processes` counter is system-wide, so these absolute fork
counts include MySQL, Docker, Apache, and other WSL services. Post-change
measurements must use the same WSL session and scenarios; only the delta is
meaningful. CPU is the lifetime average reported by `ps`, while the app
snapshot is the latest interval measured with `process.cpuUsage()`.

## After local direct-file sampling

Measured in the same WSL session and Scenario A after the executor
`readFiles` fast path was added:

- System-wide process creations over 60 seconds: **6**, down from **214**
  (**97.2% reduction**)
- Server RSS samples: **70,892; 70,768; 70,384; 70,900; 70,344 KiB**
- App self snapshot: **0.12% CPU**, **70,713,344 bytes RSS**
- Last system tick: **1 ms** (**0.05%** estimated interval cost), down from
  6 ms / 0.30%

The `ps` CPU samples began at 1.9% and fell to 0.3% because `ps` reports a
lifetime average and this server had just started; they are not compared to
the long-running pre-change process. The fork counter and per-tick app
measurement are directly comparable and show the intended zero-process steady
state (the six remaining creations came from the measurement command and
unrelated WSL services).

## Module command reductions

Deterministic executor-counting tests verify:

- 14 simultaneous Network Host tuning bindings: **14 probes → 1**
- Four Docker drawer bindings for one container: **4 inspect calls → 1**
- Normal GPU fallback tick after discovery: **3 `nvidia-smi` calls → 2**

On the WSL host's RTX 3070 Ti, the two remaining one-shot GPU commands took
**79.9 ms per tick** averaged over 20 ticks. That justified the optional
streaming phase. A real-GPU runtime check then produced four snapshots in 3.5
seconds with one persistent `nvidia-smi -lms` process, one process query per
sample, and zero children left after disposal. Steady-state GPU process
creation is therefore **2 → 1 per tick**, plus the one long-lived metrics
process; unit tests cover retry backoff and the bounded fallback path.
