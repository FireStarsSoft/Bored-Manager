export type MutationResource =
  | 'connection'
  | 'settings'
  | 'users'
  | 'packages'
  | 'modules'
  | 'update'

/**
 * A small keyed mutex. Reads register no resource and stay concurrent;
 * mutations naming the same domain are serialized across every client.
 */
export class ResourceCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(resources: readonly MutationResource[], operation: () => T | Promise<T>): Promise<T> {
    const names = [...new Set(resources)].sort()
    const releases: Array<() => void> = []
    try {
      for (const name of names) releases.push(await this.acquire(name))
      return await operation()
    } finally {
      for (const release of releases.reverse()) release()
    }
  }

  private async acquire(name: string): Promise<() => void> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    let releaseGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const current = previous.then(() => gate)
    this.tails.set(name, current)
    await previous

    let released = false
    return () => {
      if (released) return
      released = true
      releaseGate()
      void current.finally(() => {
        if (this.tails.get(name) === current) this.tails.delete(name)
      })
    }
  }
}
