import * as React from 'react'
import GridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type LayoutItem
} from 'react-grid-layout'
import type { OverviewLayoutItem } from '@shared/types'
import 'react-grid-layout/css/styles.css'

/**
 * Grid geometry. Row height is deliberately tiny: card heights are derived
 * from their content, and a small row makes the quantisation invisible
 * (a card can only be off by rowHeight + margin = 16px).
 */
const ROW_HEIGHT = 4
const MARGIN: [number, number] = [12, 12]
const WIDE_COLS = 6
const NARROW_COLS = 4
const WIDE_MIN_WIDTH = 1180
const DEFAULT_ROWS = 8

export interface OverviewCard {
  id: string
  /** width in grid units; 2 = a third of a wide screen, half of a narrow one */
  w?: number
  node: React.ReactNode
}

export type GridBreakpoint = 'lg' | 'md'

function rowsFor(px: number): number {
  return Math.max(1, Math.ceil((px + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])))
}

function signature(layout: Layout): string {
  return layout
    .map((i) => `${i.i}:${i.x},${i.y},${i.w}`)
    .sort()
    .join('|')
}

/**
 * Draggable Overview grid.
 *
 * Cards keep the height of their content (a Sensors card with four readings
 * stays short) and can be dragged anywhere; the vertical compactor pulls
 * everything up so no gaps are left behind. Positions are persisted per
 * breakpoint by the parent.
 */
export function OverviewGrid({
  cards,
  saved,
  onSaveLayout
}: {
  cards: OverviewCard[]
  saved: Partial<Record<GridBreakpoint, OverviewLayoutItem[]>> | undefined
  onSaveLayout: (breakpoint: GridBreakpoint, items: OverviewLayoutItem[]) => void
}): React.JSX.Element {
  const { width, containerRef, mounted } = useContainerWidth()
  const cols = width >= WIDE_MIN_WIDTH ? WIDE_COLS : NARROW_COLS
  const breakpoint: GridBreakpoint = cols === WIDE_COLS ? 'lg' : 'md'
  const [rows, setRows] = React.useState<Record<string, number>>({})
  const savedForBp = saved?.[breakpoint]

  // Keyed on the card ids, not the array: the parent rebuilds `cards` on
  // every metrics tick and the layout must not churn with it.
  const cardIds = cards.map((c) => `${c.id}:${c.w ?? 2}`).join(',')
  const layout = React.useMemo<Layout>(() => {
    const perRow = Math.max(1, Math.floor(cols / 2))
    return cardIds.split(',').map((entry, index) => {
      const [id, rawW] = entry.split(':')
      const stored = savedForBp?.find((s) => s.i === id)
      const w = Math.min(cols, stored ? stored.w : Number(rawW) || 2)
      const item: LayoutItem = {
        i: id,
        x: stored ? Math.min(stored.x, Math.max(0, cols - w)) : (index % perRow) * 2,
        // Unknown cards go to the bottom; the compactor pulls them up into
        // the first free slot.
        y: stored ? stored.y : 1000 + index,
        w,
        h: rows[id] ?? DEFAULT_ROWS
      }
      return item
    })
  }, [cardIds, savedForBp, cols, rows])

  /**
   * Persist only what the user controls, and only after an actual drag or
   * resize - `onLayoutChange` also fires for compaction and measurement, so
   * saving from there would immediately re-create a layout the user just
   * reset.
   */
  const persist = React.useCallback(
    (next: Layout) => {
      const items = next.map((i) => ({ i: i.i, x: i.x, y: i.y, w: i.w }))
      if (savedForBp && signature(savedForBp as unknown as Layout) === signature(next)) return
      onSaveLayout(breakpoint, items)
    },
    [breakpoint, onSaveLayout, savedForBp]
  )

  const measure = React.useCallback((id: string, px: number) => {
    setRows((prev) => {
      const next = rowsFor(px)
      return prev[id] === next ? prev : { ...prev, [id]: next }
    })
  }, [])

  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols, rowHeight: ROW_HEIGHT, margin: MARGIN, containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, handle: '.tm-drag-handle' }}
          resizeConfig={{ enabled: true, handles: ['e'] }}
          compactor={verticalCompactor}
          onDragStop={persist}
          onResizeStop={persist}
        >
          {cards.map((card) => (
            <div key={card.id}>
              <AutoHeight id={card.id} onMeasure={measure}>
                {card.node}
              </AutoHeight>
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  )
}

/**
 * Reports the natural height of its content so the grid can size the row.
 * The wrapper itself must stay auto-height, otherwise it would measure the
 * height the grid just gave it and oscillate.
 */
function AutoHeight({
  id,
  onMeasure,
  children
}: {
  id: string
  onMeasure: (id: string, px: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    onMeasure(id, el.offsetHeight)
    const observer = new ResizeObserver(() => onMeasure(id, el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, onMeasure])
  return <div ref={ref}>{children}</div>
}
