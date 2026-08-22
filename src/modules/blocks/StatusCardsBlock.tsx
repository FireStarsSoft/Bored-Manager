import * as React from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Search } from 'lucide-react'
import type { StatusCardsBlock } from '@shared/module-ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { SelectField } from '@/components/select-field'
import { cn } from '@/lib/utils'
import { BlockData, resolvePath } from '../binding'
import { ActionButton } from '../action-runner'
import { BlockList, type BlockCtx } from '../BlockRenderer'

/**
 * A wall of small cards, one per item in the resolved array: a title row tinted
 * by that item's own status, a collapsible note, and status chips clamped to a
 * couple of rows with an expand control. `table` cannot stand in for this - it
 * draws one row per item and has no data-driven colour - and `section.columns`
 * only grids blocks the spec listed by hand, so the card count could not come
 * from the data.
 */

type CardStatus = 'ok' | 'warn' | 'bad' | 'unknown'

type Row = Record<string, unknown>

interface Chip {
  label: string
  status: CardStatus
  pinned: boolean
}

interface CardModel {
  id: string
  title: string
  status: CardStatus
  subtitle: string
  note: string
  chips: Chip[]
  row: Row
}

/** Worst first: a wall is read for what is wrong, not for what is fine. */
const STATUS_WEIGHT: Record<CardStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

/** Health tokens, never literal colours - the wall has to survive a theme switch. */
const TITLE_TINT: Record<CardStatus, string> = {
  ok: 'border-success/30 bg-success/10 text-success',
  warn: 'border-warning/30 bg-warning/10 text-warning',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  unknown: 'border-border bg-muted text-muted-foreground'
}

const CHIP_VARIANT: Record<CardStatus, 'success' | 'warning' | 'destructive' | 'outline'> = {
  ok: 'success',
  warn: 'warning',
  bad: 'destructive',
  unknown: 'outline'
}

/**
 * One chip row is `h-5` plus a `gap-1`, both in rem, so the clamp follows the
 * density setting instead of pinning the card to one root font size.
 */
const CHIP_ROW_REM = 1.5

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function toStatus(value: unknown): CardStatus {
  return value === 'ok' || value === 'warn' || value === 'bad' ? value : 'unknown'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Titles are usually addresses, and `10.0.0.9` has to sort before `10.0.0.10`. */
function compareTitle(a: string, b: string): number {
  const left = IPV4.exec(a)
  const right = IPV4.exec(b)
  if (left && right) {
    for (let i = 1; i <= 4; i++) {
      const diff = Number(left[i]) - Number(right[i])
      if (diff !== 0) return diff
    }
    return 0
  }
  return a.localeCompare(b)
}

function toChips(value: unknown, cfg: StatusCardsBlock['items']): Chip[] {
  if (!Array.isArray(value)) return []
  const labelKey = cfg.labelKey ?? 'label'
  const statusKey = cfg.statusKey ?? 'status'
  const pinnedKey = cfg.pinnedKey ?? 'pinned'
  const out: Chip[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry) out.push({ label: entry, status: 'unknown', pinned: false })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const label = resolvePath(entry, labelKey)
    if (label == null || label === '') continue
    out.push({
      label: String(label),
      status: toStatus(resolvePath(entry, statusKey)),
      pinned: resolvePath(entry, pinnedKey) === true
    })
  }
  out.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] ||
      a.label.localeCompare(b.label)
  )
  return out
}

/**
 * Each card owns its own note/expand state and its own measurement, keyed by
 * `rowKey` - so a refresh that re-sorts the wall does not close a drawer, a
 * note or an expanded chip list the user just opened.
 */
function StatusCardView({
  card,
  block,
  ctx,
  onOpen,
  onActionDone
}: {
  card: CardModel
  block: StatusCardsBlock
  ctx: BlockCtx
  onOpen: () => void
  onActionDone: () => void
}): React.JSX.Element {
  const [noteOpen, setNoteOpen] = React.useState(block.note?.startOpen === true)
  const [expanded, setExpanded] = React.useState(false)
  const [hidden, setHidden] = React.useState(0)
  const chipsRef = React.useRef<HTMLDivElement>(null)
  const rows = Math.max(1, block.items.visibleRows ?? 2)
  const hasNote = block.note != null && card.note !== ''

  // Only measured while clamped: once expanded the container is its own full
  // height, so measuring again would say "nothing is hidden" and take away the
  // control that closes it.
  React.useLayoutEffect(() => {
    const el = chipsRef.current
    if (!el || expanded) return
    const measure = (): void => {
      const limit = el.clientHeight
      let count = 0
      for (const child of Array.from(el.children)) {
        if ((child as HTMLElement).offsetTop >= limit) count++
      }
      setHidden(count)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, card.chips, rows])

  const clampable = hidden > 0 || expanded

  return (
    <Card
      className={cn('gap-0 overflow-hidden p-0', block.rowDetail && 'cursor-pointer')}
      onClick={block.rowDetail ? onOpen : undefined}
    >
      <div className={cn('flex items-center gap-1 border-b px-2 py-1', TITLE_TINT[card.status])}>
        <span className="mono min-w-0 flex-1 truncate text-xs font-medium">{card.title || '—'}</span>
        {card.subtitle !== '' && (
          <span className="shrink-0 text-[0.6875rem] tabular-nums opacity-80">{card.subtitle}</span>
        )}
        {block.rowActions?.length ? (
          <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {block.rowActions.map((action, i) => (
              <ActionButton
                key={i}
                action={action}
                moduleId={ctx.moduleId}
                scope={card.row}
                onDone={onActionDone}
              />
            ))}
          </span>
        ) : null}
        {hasNote && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={noteOpen}
            aria-label={noteOpen ? 'Hide notes' : 'Show notes'}
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              setNoteOpen((open) => !open)
            }}
          >
            {noteOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </Button>
        )}
      </div>

      {hasNote && (
        <Collapsible open={noteOpen} onOpenChange={setNoteOpen}>
          <CollapsibleContent className="border-b bg-muted/30 px-2 py-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
            {block.note?.label ? <span className="font-medium">{block.note.label}: </span> : null}
            {card.note}
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="p-2">
        {card.chips.length === 0 ? (
          <div className="text-[0.6875rem] text-muted-foreground">
            {block.items.emptyText ?? 'Nothing to show'}
          </div>
        ) : (
          <>
            <div
              ref={chipsRef}
              className="relative flex flex-wrap gap-1"
              style={expanded ? undefined : { maxHeight: `${rows * CHIP_ROW_REM}rem`, overflow: 'hidden' }}
            >
              {card.chips.map((chip, i) => (
                <Badge
                  key={`${chip.label}-${i}`}
                  variant={CHIP_VARIANT[chip.status]}
                  className={cn(
                    'h-5 max-w-full truncate px-1.5 text-[0.6875rem]',
                    chip.pinned ? 'font-medium' : 'font-normal'
                  )}
                >
                  {chip.label}
                </Badge>
              ))}
            </div>
            {clampable && (
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={expanded}
                className="mt-1 h-5 w-full justify-center text-[0.6875rem] text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded((open) => !open)
                }}
              >
                {expanded ? (
                  <>
                    <ChevronUp aria-hidden /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown aria-hidden /> {hidden} more
                  </>
                )}
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

export function StatusCardsBlockView({
  block,
  ctx
}: {
  block: StatusCardsBlock
  ctx: BlockCtx
}): React.JSX.Element {
  return (
    <BlockData moduleId={ctx.moduleId} source={block.source} opts={ctx}>
      {({ value, refetch }) => (
        <StatusCardsContent block={block} ctx={ctx} value={value} refetch={refetch} />
      )}
    </BlockData>
  )
}

function StatusCardsContent({
  block,
  ctx,
  value,
  refetch
}: {
  block: StatusCardsBlock
  ctx: BlockCtx
  value: unknown
  refetch: () => void
}): React.JSX.Element {
  const rows = React.useMemo<Row[]>(() => (Array.isArray(value) ? (value as Row[]) : []), [value])

  const minCols = Math.max(1, block.columns?.min ?? 1)
  const maxCols = Math.max(minCols, block.columns?.max ?? 8)
  const [cols, setCols] = React.useState(() => clamp(block.columns?.default ?? 4, minCols, maxCols))
  const [filterText, setFilterText] = React.useState('')
  const [pinnedOnly, setPinnedOnly] = React.useState(false)
  const [detailKey, setDetailKey] = React.useState<string | null>(null)
  const lastDetailRowRef = React.useRef<Row | null>(null)

  const cards = React.useMemo<CardModel[]>(() => {
    const out = rows.map((row) => {
      const subtitle = block.subtitleKey ? resolvePath(row, block.subtitleKey) : null
      const note = block.note ? resolvePath(row, block.note.key) : null
      return {
        id: String(resolvePath(row, block.rowKey) ?? ''),
        title: String(resolvePath(row, block.titleKey) ?? ''),
        status: toStatus(resolvePath(row, block.statusKey)),
        subtitle: subtitle == null ? '' : String(subtitle),
        note: note == null ? '' : String(note),
        chips: toChips(resolvePath(row, block.items.key), block.items),
        row
      }
    })
    out.sort(
      (a, b) => STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] || compareTitle(a.title, b.title)
    )
    return out
  }, [rows, block])

  const shown = React.useMemo(() => {
    const base = pinnedOnly ? cards.map((c) => ({ ...c, chips: c.chips.filter((ch) => ch.pinned) })) : cards
    const query = filterText.trim().toLowerCase()
    if (!query) return base
    return base.filter(
      (c) =>
        c.title.toLowerCase().includes(query) ||
        c.note.toLowerCase().includes(query) ||
        c.chips.some((ch) => ch.label.toLowerCase().includes(query))
    )
  }, [cards, filterText, pinnedOnly])

  // The drawer follows its card by id through every refresh, and falls back to
  // the last copy seen if that card drops out of the data entirely.
  const liveDetailRow = detailKey == null ? undefined : cards.find((c) => c.id === detailKey)?.row
  const detailRow = liveDetailRow ?? lastDetailRowRef.current
  React.useEffect(() => {
    if (liveDetailRow) lastDetailRowRef.current = liveDetailRow
  }, [liveDetailRow])

  const colOptions = React.useMemo(
    () =>
      Array.from({ length: maxCols - minCols + 1 }, (_, i) => ({
        value: String(minCols + i),
        label: String(minCols + i)
      })),
    [minCols, maxCols]
  )

  // An Overview card is a fraction of the width a page has; more than two
  // columns in there is unreadable whatever the spec asked for.
  const effectiveCols = ctx.compact ? Math.min(cols, 2) : cols

  return (
    <div>
      {!ctx.compact && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search
              className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="pl-7"
              placeholder="Filter…"
              aria-label="Filter cards"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
          {block.items.pinnedFilterLabel && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={pinnedOnly}
                onCheckedChange={(on) => setPinnedOnly(on === true)}
              />
              {block.items.pinnedFilterLabel}
            </label>
          )}
          {colOptions.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Columns
              <SelectField
                value={String(cols)}
                onChange={(v) => setCols(clamp(Number(v), minCols, maxCols))}
                options={colOptions}
                aria-label="Cards per row"
                className="w-16"
              />
            </label>
          )}
          <div className="text-xs text-muted-foreground">{shown.length} shown</div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-md border border-border p-4 text-center text-xs text-muted-foreground">
          {block.emptyText ?? 'Nothing to show'}
        </div>
      ) : (
        <div
          className="grid gap-2"
          // The column count is a runtime choice, and Tailwind only ships class
          // names it can see in the source (see SectionBlock) - so this one grid
          // template is set inline rather than through a generated class.
          style={{ gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))` }}
        >
          {shown.map((card) => (
            <StatusCardView
              key={card.id}
              card={card}
              block={block}
              ctx={ctx}
              onOpen={() => setDetailKey(card.id)}
              onActionDone={refetch}
            />
          ))}
        </div>
      )}

      {block.rowDetail && (
        <Sheet open={detailKey != null} onOpenChange={(open) => !open && setDetailKey(null)}>
          <SheetContent side="right" className="w-full sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>Details</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {detailRow && <BlockList blocks={block.rowDetail} ctx={{ ...ctx, scope: detailRow }} />}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
