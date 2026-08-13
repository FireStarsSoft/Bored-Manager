/**
 * Pure sort/filter/group/aggregate logic for `TableBlock`, kept free of React
 * so it is straightforward to test on its own.
 */
import type { TableColumn, TableGroupMode, TableSortDefault } from '@shared/module-ui'

export type Row = Record<string, unknown>
export type SortState = { key: string; dir: 'asc' | 'desc' } | null

export interface DisplayRow {
  key: string
  depth: number
  row: Row
  isGroupHeader: boolean
  /** The grouped value itself, e.g. `"root"` for a `user` group - independent of which column happens to be first. */
  groupLabel?: string
  groupCount?: number
  hasChildren: boolean
  collapsed: boolean
  /** Sums for `aggregate` columns - shown for a group header, or a collapsed tree node standing in for its subtree. */
  aggregates: Record<string, number> | null
}

export function toSortState(d: TableSortDefault | undefined): SortState {
  return d ? { key: d.key, dir: d.dir } : null
}

export function defaultTextColumns(columns: TableColumn[]): string[] {
  return columns.filter((c) => !c.format || c.format === 'text').map((c) => c.key)
}

export function cellAlign(col: TableColumn): 'left' | 'right' {
  if (col.align) return col.align
  return col.format && col.format !== 'text' ? 'right' : 'left'
}

export function filterRows(rows: Row[], filterText: string, filterKeys: string[]): Row[] {
  const q = filterText.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => filterKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)))
}

function compareRows(a: Row, b: Row, key: string, dir: 'asc' | 'desc'): number {
  const va = a[key]
  const vb = b[key]
  const mul = dir === 'asc' ? 1 : -1
  if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul
  return String(va ?? '').localeCompare(String(vb ?? '')) * mul
}

export function sortRows(rows: Row[], sort: SortState): Row[] {
  return sort ? [...rows].sort((a, b) => compareRows(a, b, sort.key, sort.dir)) : rows
}

function sumColumn(rows: Row[], key: string): number {
  return rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0)
}

export function buildFlat(rows: Row[], idKey: string, sort: SortState): DisplayRow[] {
  return sortRows(rows, sort).map((row) => ({
    key: String(row[idKey]),
    depth: 0,
    row,
    isGroupHeader: false,
    hasChildren: false,
    collapsed: false,
    aggregates: null
  }))
}

export function buildFlatGroups(
  rows: Row[],
  mode: TableGroupMode,
  idKey: string,
  sort: SortState,
  aggregateKeys: string[],
  collapsed: Set<string>
): DisplayRow[] {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const gv = String(r[mode.key] ?? '—')
    const list = groups.get(gv) ?? []
    list.push(r)
    groups.set(gv, list)
  }
  const entries = [...groups.entries()].map(([groupValue, members]) => {
    const aggregates: Record<string, number> = {}
    for (const k of aggregateKeys) aggregates[k] = sumColumn(members, k)
    return { groupValue, members, aggregates }
  })
  // A group sorts by its own total for the selected column when that column
  // has one (clicking "CPU" should bring the busiest group to the top, the
  // same way it brings the busiest row to the top with no grouping);
  // otherwise - no sort yet, or the selected column is not a summable one -
  // groups fall back to their label so the list is at least stable.
  const sortKey = sort?.key
  const byAggregate = sortKey != null && aggregateKeys.includes(sortKey)
  const mul = sort?.dir === 'desc' ? -1 : 1
  entries.sort((a, b) =>
    byAggregate ? (a.aggregates[sortKey] - b.aggregates[sortKey]) * mul : a.groupValue.localeCompare(b.groupValue)
  )
  const out: DisplayRow[] = []
  for (const { groupValue, members, aggregates } of entries) {
    const groupKey = `group:${mode.id}:${groupValue}`
    const isCollapsed = collapsed.has(groupKey)
    out.push({
      key: groupKey,
      depth: 0,
      row: { [mode.key]: groupValue },
      isGroupHeader: true,
      groupLabel: groupValue,
      groupCount: members.length,
      hasChildren: members.length > 0,
      collapsed: isCollapsed,
      aggregates
    })
    if (!isCollapsed) out.push(...buildFlat(members, idKey, sort))
  }
  return out
}

export function buildTree(
  rows: Row[],
  mode: TableGroupMode,
  idKey: string,
  sort: SortState,
  aggregateKeys: string[],
  collapsed: Set<string>
): DisplayRow[] {
  const parentIdKey = mode.parentIdKey as string
  const byParentId = new Map<string, Row>()
  for (const r of rows) byParentId.set(String(r[parentIdKey]), r)
  const childrenOf = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of rows) {
    const parentRef = r[mode.key]
    const parent = parentRef != null ? byParentId.get(String(parentRef)) : undefined
    if (parent && parent !== r) {
      const list = childrenOf.get(String(parent[parentIdKey])) ?? []
      list.push(r)
      childrenOf.set(String(parent[parentIdKey]), list)
    } else {
      roots.push(r)
    }
  }

  const descendants = (r: Row): Row[] => {
    const kids = childrenOf.get(String(r[parentIdKey])) ?? []
    return kids.flatMap((k) => [k, ...descendants(k)])
  }

  const out: DisplayRow[] = []
  const visit = (r: Row, depth: number): void => {
    const rowKey = String(r[idKey])
    const kids = sortRows(childrenOf.get(String(r[parentIdKey])) ?? [], sort)
    const isCollapsed = kids.length > 0 && collapsed.has(rowKey)
    let aggregates: Record<string, number> | null = null
    if (isCollapsed) {
      const subtree = [r, ...descendants(r)]
      aggregates = {}
      for (const k of aggregateKeys) aggregates[k] = sumColumn(subtree, k)
    }
    out.push({
      key: rowKey,
      depth,
      row: r,
      isGroupHeader: false,
      hasChildren: kids.length > 0,
      collapsed: isCollapsed,
      aggregates
    })
    if (!isCollapsed) for (const kid of kids) visit(kid, depth + 1)
  }
  for (const r of sortRows(roots, sort)) visit(r, 0)
  return out
}

/** Picks the right builder for the table's current grouping (or none). */
export function buildDisplayRows(
  rows: Row[],
  idKey: string,
  sort: SortState,
  mode: TableGroupMode | undefined,
  aggregateKeys: string[],
  collapsed: Set<string>
): DisplayRow[] {
  if (!mode) return buildFlat(rows, idKey, sort)
  if (mode.parentIdKey) return buildTree(rows, mode, idKey, sort, aggregateKeys, collapsed)
  return buildFlatGroups(rows, mode, idKey, sort, aggregateKeys, collapsed)
}
