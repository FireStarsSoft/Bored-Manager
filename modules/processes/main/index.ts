import type { ModuleActivate } from '@shared/modules'
import { killProcess, listProcesses, reniceProcess } from './service'

/**
 * Main-process half of the Processes module. There is no poller here: the page
 * pulls the table itself while it is open, on the "Processes" fast interval, so
 * nothing is collected when the page is not being looked at.
 */
const activate: ModuleActivate = (ctx) => {
  ctx.handle('list', () => listProcesses(ctx))
  ctx.handle('kill', (pid: number, signal: 'TERM' | 'KILL', asRoot: boolean) =>
    killProcess(ctx, pid, signal, asRoot)
  )
  ctx.handle('renice', (pid: number, nice: number) => reniceProcess(ctx, pid, nice))

  return {
    dispose() {
      /* nothing long-running to release */
    }
  }
}

export default activate
