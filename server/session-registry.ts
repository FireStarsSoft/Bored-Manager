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

export type SessionRegistryState = 'active' | 'shutting-down' | 'disposed'

export class SessionRegistry {
  private items = new Map<string, Disposable>()
  private lateDisposals = new Set<Promise<void>>()
  private counter = 0
  private stateValue: SessionRegistryState = 'active'
  private shutdownPromise: Promise<void> | null = null

  constructor(
    private readonly logger: (message: string, error?: unknown) => void = (message, error) =>
      console.error(message, error ?? '')
  ) {}

  register(name: string, dispose: () => void | Promise<void>): string {
    const id = `${name}#${++this.counter}`
    const item = { name, dispose }
    if (this.stateValue === 'active') {
      this.items.set(id, item)
    } else if (this.stateValue === 'shutting-down') {
      this.trackLateDisposal(item)
    } else {
      // The drain is already complete, but a caller racing shutdown still
      // receives immediate cleanup rather than an untracked live resource.
      void this.disposeItem(item)
    }
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
    await this.disposeItem(item)
  }

  /**
   * Dispose until both the main registry and resources registered by
   * disposers are empty. The deadline bounds a broken disposer without
   * reverting to the one-time-snapshot race this registry exists to prevent.
   */
  disposeAll(timeoutMs = 5000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    if (this.stateValue === 'disposed') return Promise.resolve()
    this.stateValue = 'shutting-down'
    this.shutdownPromise = this.drain(Math.max(0, timeoutMs)).finally(() => {
      this.stateValue = 'disposed'
      this.items.clear()
    })
    return this.shutdownPromise
  }

  get state(): SessionRegistryState {
    return this.stateValue
  }

  get size(): number {
    return this.items.size + this.lateDisposals.size
  }

  private async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const current = [...this.items.values()]
      this.items.clear()
      const work = [
        ...current.map((item) => this.disposeItem(item)),
        ...this.lateDisposals
      ]
      if (work.length === 0) {
        // Let a disposer that just resolved schedule its final registration.
        await Promise.resolve()
        if (this.items.size === 0 && this.lateDisposals.size === 0) return
        continue
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0 || !(await this.settleWithin(work, remaining))) {
        this.logger(
          `[session-registry] shutdown deadline reached with ` +
            `${this.items.size + this.lateDisposals.size} resource(s) still disposing`
        )
        return
      }
    }
  }

  private async settleWithin(work: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null
    const completed = await Promise.race([
      Promise.allSettled(work).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)
    return completed
  }

  private trackLateDisposal(item: Disposable): void {
    const work = this.disposeItem(item)
    this.lateDisposals.add(work)
    void work.finally(() => this.lateDisposals.delete(work))
  }

  private async disposeItem(item: Disposable): Promise<void> {
    try {
      await item.dispose()
    } catch (error) {
      this.logger(`[session-registry] failed to dispose "${item.name}"`, error)
    }
  }
}

export const registry = new SessionRegistry()
