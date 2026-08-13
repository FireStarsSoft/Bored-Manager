import * as React from 'react'
import {
  columnVisibilityFeature,
  flexRender,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnVisibilityState
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Columns3, Search } from 'lucide-react'
import type { TableBlock, TableColumn } from '@shared/module-ui'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/components/select-field'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useBlockDataWithRefetch } from '../binding'
import { ActionButton } from '../action-runner'
import { formatBlockValue } from '../format'
import { BlockList, type BlockCtx } from '../BlockRenderer'
import {
  buildDisplayRows,
  cellAlign,
  defaultTextColumns,
  filterRows,
  toSortState,
  type DisplayRow,
  type Row,
  type SortState
} from './table-logic'

/**
 * Sorting, filtering and grouping stay in table-logic.ts: this table inserts
 * synthetic group-header rows and sums a collapsed subtree in place, neither of
 * which is what TanStack's grouping or expanding models do. TanStack is here for
 * the column definitions, the header/cell rendering and column visibility.
 */
const features = tableFeatures({ columnVisibilityFeature })

/** Past this many rows the table gets its own viewport and is windowed. */
const VIRTUALIZE_ABOVE = 200
const ROW_HEIGHT = 26

export function TableBlockView({ block, ctx }: { block: TableBlock; ctx: BlockCtx }): React.JSX.Element {
  const { value, refetch } = useBlockDataWithRefetch(ctx.moduleId, block.source, ctx)
  const rows = React.useMemo<Row[]>(() => (Array.isArray(value) ? (value as Row[]) : []), [value])
  const idKey = block.rowKey ?? block.columns[0]?.key ?? 'id'

  const [filterText, setFilterText] = React.useState('')
  const [sortState, setSortState] = React.useState<SortState>(toSortState(block.sortDefault))
  const [groupModeId, setGroupModeId] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})
  // Identifies the open drawer's row rather than pinning the row object itself, so the
  // drawer keeps tracking that row's own live updates instead of freezing on a click-time snapshot.
  const [detailKey, setDetailKey] = React.useState<string | null>(null)
  const lastDetailRowRef = React.useRef<Row | null>(null)

  React.useEffect(() => setCollapsed(new Set()), [groupModeId])

  const filtered = React.useMemo(
    () => filterRows(rows, filterText, block.filterKeys ?? defaultTextColumns(block.columns)),
    [rows, filterText, block.filterKeys, block.columns]
  )

  const groupMode = block.groupModes?.find((m) => m.id === groupModeId)
  const aggregateKeys = React.useMemo(
    () => block.columns.filter((c) => c.aggregate).map((c) => c.key),
    [block.columns]
  )

  const displayRows = React.useMemo(
    () => buildDisplayRows(filtered, idKey, sortState, groupMode, aggregateKeys, collapsed),
    [filtered, groupMode, idKey, sortState, aggregateKeys, collapsed]
  )

  // Re-finds the open row in every fresh poll of `rows` by id, so the drawer's data
  // stays live; falls back to the last row seen for that id if it drops out (process
  // exited, container removed) instead of the drawer going blank underneath the user.
  const liveDetailRow = detailKey == null ? undefined : rows.find((r) => String(r[idKey]) === detailKey)
  const detailRow = liveDetailRow ?? lastDetailRowRef.current
  React.useEffect(() => {
    if (liveDetailRow) lastDetailRowRef.current = liveDetailRow
  }, [liveDetailRow])

  const toggleSort = (col: TableColumn): void => {
    if (col.sortable === false) return
    setSortState((prev) =>
      prev?.key === col.key ? { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'asc' }
    )
  }

  const toggleCollapse = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const columns = React.useMemo<Array<ColumnDef<typeof features, DisplayRow>>>(() => {
    const defs: Array<ColumnDef<typeof features, DisplayRow>> = block.columns.map((col, i) => ({
      id: col.key,
      header: col.label,
      meta: { align: cellAlign(col) },
      cell: ({ row }) => {
        const dr = row.original
        if (i === 0) {
          return (
            <span className="flex items-center gap-1" style={{ paddingLeft: dr.depth * 14 }}>
              {dr.hasChildren && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-expanded={!dr.collapsed}
                  aria-label={dr.collapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleCollapse(dr.key)
                  }}
                >
                  {dr.collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
                </Button>
              )}
              <span className="truncate">
                {dr.isGroupHeader
                  ? `${dr.groupLabel ?? '—'} (${dr.groupCount})`
                  : formatBlockValue(col.format, dr.row[col.key])}
              </span>
            </span>
          )
        }
        if (dr.isGroupHeader) {
          return col.aggregate ? formatBlockValue(col.format, dr.aggregates?.[col.key]) : ''
        }
        if (dr.collapsed && col.aggregate && dr.aggregates) {
          return formatBlockValue(col.format, dr.aggregates[col.key])
        }
        return formatBlockValue(col.format, dr.row[col.key])
      }
    }))

    if (block.rowActions?.length) {
      defs.push({
        id: '__actions',
        header: '',
        enableHiding: false,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const dr = row.original
          if (dr.isGroupHeader) return null
          return (
            <div
              className="flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              {block.rowActions?.map((action, i) => (
                <ActionButton
                  key={i}
                  action={action}
                  moduleId={ctx.moduleId}
                  scope={dr.row}
                  onDone={refetch}
                />
              ))}
            </div>
          )
        }
      })
    }
    return defs
  }, [block.columns, block.rowActions, ctx.moduleId, refetch])

  const table = useTable({
    features,
    data: displayRows,
    columns,
    getRowId: (dr) => dr.key,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility
  })

  const tableRows = table.getRowModel().rows
  const virtualize = tableRows.length > VIRTUALIZE_ABOVE
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    enabled: virtualize
  })
  const virtualItems = virtualize ? virtualizer.getVirtualItems() : null
  const padTop = virtualItems?.length ? virtualItems[0].start : 0
  const padBottom = virtualItems?.length
    ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0
  const shown = virtualItems ? virtualItems.map((v) => tableRows[v.index]) : tableRows
  const colCount = table.getVisibleLeafColumns().length

  const groupOptions = [
    { value: '', label: 'No grouping' },
    ...(block.groupModes ?? []).map((m) => ({ value: m.id, label: m.label }))
  ]

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search
            className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-7"
            placeholder="Filter…"
            aria-label="Filter rows"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
        {!!block.groupModes?.length && (
          <SelectField
            value={groupModeId}
            onChange={setGroupModeId}
            options={groupOptions}
            aria-label="Group rows by"
            className="w-44"
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 aria-hidden /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Show columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.getIsVisible()}
                  onCheckedChange={(v) => c.toggleVisibility(v)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {block.columns.find((bc) => bc.key === c.id)?.label ?? c.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="text-xs text-muted-foreground">{filtered.length} rows</div>
      </div>

      <Card className="overflow-hidden p-0">
        <div
          ref={scrollRef}
          className="overflow-auto"
          style={virtualize ? { maxHeight: '70vh' } : undefined}
        >
          <Table className="text-xs">
            <TableHeader className="sticky top-0 z-10 bg-accent">
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const col = block.columns.find((c) => c.key === header.column.id)
                    const sortable = col != null && col.sortable !== false
                    const sorted = sortState?.key === header.column.id ? sortState.dir : null
                    const align = header.column.columnDef.meta?.align
                    return (
                      <TableHead
                        key={header.id}
                        className={cn(
                          'h-7 px-2 font-medium text-muted-foreground',
                          align === 'right' && 'text-right'
                        )}
                        aria-sort={
                          sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : sortable
                                ? 'none'
                                : undefined
                        }
                      >
                        {header.isPlaceholder ? null : sortable ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            className={cn(
                              '-mx-1 font-medium text-muted-foreground hover:text-foreground',
                              align === 'right' && 'ml-auto'
                            )}
                            onClick={() => toggleSort(col)}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' ? (
                              <ArrowUp aria-hidden />
                            ) : sorted === 'desc' ? (
                              <ArrowDown aria-hidden />
                            ) : null}
                          </Button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={colCount} />
                </tr>
              )}
              {shown.map((row) => {
                const dr = row.original
                return (
                  <TableRow
                    key={row.id}
                    onClick={() => {
                      if (!dr.isGroupHeader && block.rowDetail) setDetailKey(dr.key)
                    }}
                    style={virtualize ? { height: ROW_HEIGHT } : undefined}
                    className={cn(
                      'group',
                      dr.isGroupHeader && 'bg-muted/40 font-medium',
                      !dr.isGroupHeader && block.rowDetail && 'cursor-pointer'
                    )}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          'max-w-0 truncate px-2 py-1',
                          cell.column.columnDef.meta?.align === 'right' && 'text-right'
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={colCount} />
                </tr>
              )}
              {tableRows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="py-6 text-center text-muted-foreground">
                    {block.emptyText ?? 'Nothing to show'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

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
