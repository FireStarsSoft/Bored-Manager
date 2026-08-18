/**
 * Central registry of everything the app spawns during a session
 * (pollers, terminals, log streams, watchers, SSH channels).
 * Guarantees a clean close: when the app quits, every registered
 * resource is disposed so nothing is left running on the target machine.
 */

export interface Disposable {
  name: string
  dispose(): void | Promise<void>
}

export class SessionRegistry {
  private items = new Map<string, Disposable>()
  private counter = 0

  register(name: string, dispose: () => void | Promise<void>): string {
    const id = `${name}#${++this.counter}`
    this.items.set(id, { name, dispose })
    return id
  }

  unregister(id: string): void {
    this.items.delete(id)
  }

  /** Dispose a single resource and remove it from the registry. */
  async dispose(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return
    this.items.delete(id)
    try {
      await item.dispose()
    } catch {
      /* best effort */
    }
  }

  /** Dispose everything, with a hard timeout so quit can never hang. */
  async disposeAll(timeoutMs = 5000): Promise<void> {
    const all = [...this.items.values()]
    this.items.clear()
    const work = Promise.allSettled(
      all.map(async (item) => {
        await item.dispose()
      })
    )
    await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  get size(): number {
    return this.items.size
  }
}

export const registry = new SessionRegistry()
