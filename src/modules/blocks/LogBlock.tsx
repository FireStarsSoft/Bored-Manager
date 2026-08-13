import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import type { LogBlock } from '@shared/module-ui'
import { moduleCall, moduleOn } from '@/lib/modules'
import { cn } from '@/lib/utils'
import { callAction } from '../action-runner'
import { resolvePath } from '../binding'
import type { BlockCtx } from '../BlockRenderer'

/** Lines kept in memory; older ones are dropped rather than growing forever. */
const MAX_LINES = 2000

/** A raw string is the log text itself; an object like docker's `{id, data}` is filtered to the scope's id first. */
function extractText(payload: unknown, scopeId: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (scopeId != null && 'id' in p && p['id'] !== scopeId) return null
    if (typeof p['data'] === 'string') return p['data']
  }
  return null
}

export function LogBlockView({ block, ctx }: { block: LogBlock; ctx: BlockCtx }): React.JSX.Element {
  const [lines, setLines] = React.useState<string[]>([])
  const [paused, setPaused] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const preRef = React.useRef<HTMLPreElement>(null)
  const scopeKeys = block.argsFromScope ?? []
  const scopeArgsKey = JSON.stringify(scopeKeys.map((k) => resolvePath(ctx.scope, k)))
  // Most log streams are scoped to one id (a container, a job) carried in the payload;
  // the first scope key is the conventional place to find it.
  const scopeId = scopeKeys.length ? resolvePath(ctx.scope, scopeKeys[0]) : undefined

  React.useEffect(() => {
    setLines([])
    setStartError(null)
    let cancelled = false
    const args = scopeKeys.map((key) => resolvePath(ctx.scope, key))
    if (block.startMethod) {
      // Same `{ ok: false }`-is-an-error convention as every action button, so a
      // stream that never started (bad id, target not connected) says so
      // instead of leaving "Waiting for log output…" up forever.
      callAction(ctx.moduleId, block.startMethod, args).catch((err) => {
        if (!cancelled) setStartError(err instanceof Error ? err.message : String(err))
      })
    }
    const off = moduleOn<unknown>(ctx.moduleId, block.event, (payload) => {
      const text = extractText(payload, scopeId)
      if (text == null) return
      setLines((prev) => {
        const next = [...prev, ...text.split('\n')]
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
      })
    })
    return () => {
      cancelled = true
      off()
      if (block.stopMethod) void moduleCall(ctx.moduleId, block.stopMethod, ...args)
    }
    // scopeArgsKey stands in for the scope-derived args (content, not identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.moduleId, block.event, block.startMethod, block.stopMethod, scopeArgsKey])

  // Paused freezes the scroll position, not the buffer - unpausing shows everything that arrived meanwhile.
  React.useEffect(() => {
    if (!paused) preRef.current?.scrollTo({ top: preRef.current.scrollHeight })
  }, [lines, paused])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        className="absolute right-2 top-2 z-10 rounded bg-card/80 p-1 text-muted transition-colors hover:bg-card-hover hover:text-fg cursor-pointer"
      >
        {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
      </button>
      <pre
        ref={preRef}
        className={cn(
          'h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg p-2.5 text-[0.7rem] leading-relaxed mono',
          startError && 'text-bad',
          ctx.compact && 'h-40'
        )}
      >
        {startError
          ? `Could not start: ${startError}`
          : lines.length
            ? lines.join('\n')
            : 'Waiting for log output…'}
      </pre>
    </div>
  )
}
