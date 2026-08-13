import * as React from 'react'
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFns,
  flexRender,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
  type TableFeatures
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Every table in the app registers the same capabilities, so the feature object
 * is built once at module scope - v9 wants it stable, and sharing it gives every
 * column definition one `typeof dataTableFeatures` to be typed against.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel()
})

export type DataTableFeatures = typeof dataTableFeatures
export type DataTableColumns<T extends RowData> = Array<ColumnDef<DataTableFeatures, T>>

/**
 * Right-aligning a column is a property of the column, not of every cell, so it
 * travels on `meta` rather than being repeated in each `cell` renderer.
 */
declare module '@tanstack/react-table' {
  interface ColumnMeta<TFeatures extends TableFeatures, TData extends RowData, TValue> {
    align?: 'left' | 'right'
  }
}

interface DataTableProps<T extends RowData> {
  data: T[]
  columns: DataTableColumns<T>
  /** Substring match across every column that opted into filtering. */
  globalFilter?: string
  /** Stable row identity, so sorting a live table does not shuffle React keys. */
  getRowId?: (row: T, index: number) => string
  initialSorting?: SortingState
  /** Omit for one long list; set to page instead. */
  pageSize?: number
  onRowClick?: (row: T) => void
  emptyText?: string
  /** Row height in px. Set to turn on windowing - needed above ~500 rows. */
  virtualRowHeight?: number
  /** Cap for the scroll container when virtualised. */
  maxHeight?: string
  className?: string
}

export function DataTable<T extends RowData>({
  data,
  columns,
  globalFilter,
  getRowId,
  initialSorting,
  pageSize,
  onRowClick,
  emptyText = 'Nothing to show',
  virtualRowHeight,
  maxHeight = '70vh',
  className
}: DataTableProps<T>): React.JSX.Element {
  // v9 has no getState(); the slices this component renders from are owned here.
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting ?? [])
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: pageSize ?? Number.MAX_SAFE_INTEGER
  })

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId,
    state: { sorting, pagination, globalFilter: globalFilter ?? '' },
    onSortingChange: setSorting,
    onPaginationChange: setPagination
  })

  // A filter that shrinks the list below the current page must not leave the
  // table showing an empty page that no button can get out of.
  React.useEffect(() => {
    setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }))
  }, [globalFilter])

  const rows = table.getRowModel().rows
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualRowHeight ?? 28,
    overscan: 12,
    enabled: virtualRowHeight != null
  })

  const virtualRows = virtualRowHeight != null ? virtualizer.getVirtualItems() : null
  const padTop = virtualRows?.length ? virtualRows[0].start : 0
  const padBottom = virtualRows?.length
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0
  const shown = virtualRows ? virtualRows.map((v) => rows[v.index]) : rows
  const colCount = columns.length
  const pageCount = table.getPageCount()

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div
        ref={scrollRef}
        className={cn('relative min-h-0 overflow-auto', className)}
        style={virtualRowHeight != null ? { maxHeight } : undefined}
      >
        <Table className="text-xs">
          {/* Sticky so the header survives scrolling a few thousand rows. */}
          <TableHeader className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
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
                            : canSort
                              ? 'none'
                              : undefined
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          className={cn(
                            '-mx-1 font-medium text-muted-foreground hover:text-foreground',
                            align === 'right' && 'ml-auto'
                          )}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === 'asc' ? (
                            <ArrowUp aria-hidden />
                          ) : sorted === 'desc' ? (
                            <ArrowDown aria-hidden />
                          ) : (
                            <ChevronsUpDown className="opacity-40" aria-hidden />
                          )}
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
            {shown.map((row) => (
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cn('group', onRowClick && 'cursor-pointer')}
                style={virtualRowHeight != null ? { height: virtualRowHeight } : undefined}
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
            ))}
            {padBottom > 0 && (
              <tr aria-hidden style={{ height: padBottom }}>
                <td colSpan={colCount} />
              </tr>
            )}
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount} className="py-6 text-center text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pageSize != null && pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            Page {pagination.pageIndex + 1} of {pageCount} · {table.getRowCount()} rows
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
