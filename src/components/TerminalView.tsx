import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * One xterm.js view onto a server-side terminal. The terminal itself lives on
 * the server (`server/services/terminals.ts`) and is shared by every browser
 * watching it; this component only mounts the local display for it, so
 * `TerminalsTab` and a module's `terminal` block can both use it unmodified.
 */
export function TerminalView({ terminalId, visible }: { terminalId: string; visible: boolean }): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0b0f14',
        foreground: '#e6edf3',
        cursor: '#3b82f6',
        selectionBackground: '#1d4ed855'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    // Replay anything printed before this view mounted.
    void api.terminals.buffer(terminalId).then((buf) => {
      if (buf) term.write(buf)
    })

    term.onData((data) => api.terminals.write(terminalId, data))
    const unsub = api.terminals.onData(({ id, data }) => {
      if (id === terminalId) term.write(data)
    })

    const doFit = (): void => {
      try {
        fit.fit()
        api.terminals.resize(terminalId, term.cols, term.rows)
      } catch {
        /* container may be hidden */
      }
    }
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0) doFit()
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      unsub()
      term.dispose()
      termRef.current = null
    }
  }, [terminalId])

  React.useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      // Delay so the container has its final size after unhiding.
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit()
          if (termRef.current) api.terminals.resize(terminalId, termRef.current.cols, termRef.current.rows)
          termRef.current?.focus()
        } catch {
          /* ignore */
        }
      }, 30)
      return () => clearTimeout(t)
    }
  }, [visible, terminalId])

  return <div ref={containerRef} className={cn('absolute inset-0 p-2', !visible && 'invisible')} />
}
