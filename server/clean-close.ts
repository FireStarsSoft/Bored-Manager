export interface CleanCloseSteps {
  stopNewWork(): void | Promise<void>
  stopHostServices(): void | Promise<void>
  flushHistory(): void | Promise<void>
  disconnectExecutor(): void | Promise<void>
  disposeTerminals(): void | Promise<void>
  disposeRegistry(): void | Promise<void>
}

/**
 * Keep shutdown ordering explicit and testable. Each step is attempted even
 * when an earlier best-effort cleanup fails; callers still receive the
 * aggregate failure after no more cleanup can be done.
 */
export async function runCleanClose(steps: CleanCloseSteps): Promise<void> {
  const failures: unknown[] = []
  const run = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }

  await run(steps.stopNewWork)
  await run(steps.stopHostServices)
  // Producers are now stopped, so this is the boundary at which the history
  // buffer is stable and still associated with the old host.
  await run(steps.flushHistory)
  await run(steps.disconnectExecutor)
  await run(steps.disposeTerminals)
  await run(steps.disposeRegistry)

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more clean-close steps failed')
  }
}
