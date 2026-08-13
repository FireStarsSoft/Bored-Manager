import * as React from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type { TableBlock, TableColumn } from '@shared/module-ui'
import { Card } from '@/components/ui/card'
import { Drawer } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/select'
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
  type Row,
  type SortState
} from './table-logic'

export function TableBlockView({ block, ctx }: { block: TableBlock; ctx: BlockCtx }): React.JSX.Element {
  const { value, refetch } = useBlockDataWithRefetch(ctx.moduleId, block.source, ctx)
  const rows = React.useMemo<Row[]>(() => (Array.isArray(value) ? (value as Row[]) : []), [value])
  const idKey = block.rowKey ?? block.columns[0]?.key ?? 'id'

  const [filterText, setFilterText] = React.useState('')
  const [sortState, setSortState] = React.useState<SortState>(toSortState(block.sortDefault))
  const [groupModeId, setGroupModeId] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
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

  const groupOptions = [
    { value: '', label: 'No grouping' },
    ...(block.groupModes ?? []).map((m) => ({ value: m.id, label: m.label }))
  ]

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <Input
            className="pl-7"
            placeholder="Filter…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
        {!!block.groupModes?.length && (
          <SimpleSelect value={groupModeId} onChange={setGroupModeId} options={groupOptions} className="w-44" />
        )}
        <div className="text-xs text-muted">{filtered.length} rows</div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-card-hover text-muted">
              <tr>
                {block.columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col)}
                    className={cn(
                      'select-none px-2 py-1.5 font-medium',
                      col.sortable !== false && 'cursor-pointer hover:text-fg',
                      cellAlign(col) === 'right' ? 'text-right' : 'text-left'
                    )}
                  >
                    {col.label}
                    {sortState?.key === col.key ? (sortState.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
                {!!block.rowActions?.length && <th className="px-2 py-1.5" />}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((dr) => (
                <tr
                  key={dr.key}
                  onClick={() => {
                    if (!dr.isGroupHeader && block.rowDetail) setDetailKey(dr.key)
                  }}
                  className={cn(
                    'group border-t border-border/50',
                    dr.isGroupHeader ? 'bg-input/40 font-medium' : 'hover:bg-card-hover',
                    !dr.isGroupHeader && block.rowDetail && 'cursor-pointer'
                  )}
                >
                  {block.columns.map((col, i) => (
                    <td key={col.key} className={cn('px-2 py-1.5', cellAlign(col) === 'right' && 'text-right')}>
                      {i === 0 ? (
                        <span className="flex items-center gap-1" style={{ paddingLeft: dr.depth * 14 }}>
                          {dr.hasChildren && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleCollapse(dr.key)
                              }}
                              className="rounded p-0.5 text-muted hover:bg-border hover:text-fg cursor-pointer"
                            >
                              {dr.collapsed ? (
                                <ChevronRight className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          )}
                          <span className="truncate">
                            {dr.isGroupHeader
                              ? `${dr.groupLabel ?? '—'} (${dr.groupCount})`
                              : formatBlockValue(col.format, dr.row[col.key])}
                          </span>
                        </span>
                      ) : dr.isGroupHeader ? (
                        col.aggregate ? formatBlockValue(col.format, dr.aggregates?.[col.key]) : ''
                      ) : dr.collapsed && col.aggregate && dr.aggregates ? (
                        formatBlockValue(col.format, dr.aggregates[col.key])
                      ) : (
                        formatBlockValue(col.format, dr.row[col.key])
                      )}
                    </td>
                  ))}
                  {!!block.rowActions?.length && (
                    <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                      {!dr.isGroupHeader && (
                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          {block.rowActions.map((action, i) => (
                            <ActionButton
                              key={i}
                              action={action}
                              moduleId={ctx.moduleId}
                              scope={dr.row}
                              onDone={refetch}
                            />
                          ))}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {displayRows.length === 0 && (
                <tr>
                  <td
                    colSpan={block.columns.length + (block.rowActions?.length ? 1 : 0)}
                    className="px-3 py-6 text-center text-muted"
                  >
                    {block.emptyText ?? 'Nothing to show'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {block.rowDetail && (
        <Drawer open={detailKey != null} onOpenChange={(open) => !open && setDetailKey(null)} title="Details">
          {detailRow && <BlockList blocks={block.rowDetail} ctx={{ ...ctx, scope: detailRow }} />}
        </Drawer>
      )}
    </div>
  )
}
