import { KIND_ENUM, type DumpColumns } from './dump-parse'

const COLON = 0x3a
const DOT = 0x2e
const SLASH = 0x2f

/** `natural` is dump order — the order the lines appeared in the file. */
export type SortKey = 'natural' | 'path' | 'address' | 'offset' | 'name' | 'type'

export interface Query {
  typeIds?: number[] // Type ids to keep. Empty/undefined = all types.
  pathPrefix?: string // Exact prefix on the object path, e.g. "/Script/Engine".
  nameContains?: string //  Case-insensitive substring on the leaf name. 
  pathContains?: string //  Case-insensitive substring on the whole path. 
  sort?: SortKey
  descending?: boolean
}

export interface TreeChild {
  segment: string //  Segment text, without its leading separator. 
  separator: string //   The separator that introduced it: '/', '.' or ':'. 
  path: string  //  Full path prefix including this segment.
  count: number //  Objects at or under this node.
  isObject: boolean // True when an object exists at exactly this path. 
}

function fold(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 32 : c
}

function encodeLower(s: string): Uint8Array {
  return new TextEncoder().encode(s.toLowerCase())
}

export class DumpStore {
  readonly cols: DumpColumns
  private decoder = new TextDecoder()
  /** Row indices ordered by path bytes. Built lazily; powers the tree. */
  private byPath: Uint32Array | null = null

  constructor(cols: DumpColumns) {
    this.cols = cols
  }

  get count() {
    return this.cols.count
  }

  path(row: number): string {
    const { pathStart, pathBlob } = this.cols
    return this.decoder.decode(pathBlob.subarray(pathStart[row]!, pathStart[row + 1]!))
  }

  /**
   * A zero here is a real value, not a missing one: row 0 starts at
   * pathStart 0, and nameOff is 0 for any path with no separator at all
   * (`CIM_Linear`). Guarding with `!x` dropped both.
   */
  name(row: number): string {
    const { pathStart, pathBlob, nameOff } = this.cols
    return this.decoder.decode(
      pathBlob.subarray(pathStart[row]! + nameOff[row]!, pathStart[row + 1]!),
    )
  }

  /** Path minus the leaf name, minus the trailing separator. */
  container(row: number): string {
    const { pathStart, pathBlob, nameOff } = this.cols
    if (!nameOff[row]) return '' // the whole path is the name
    const end = pathStart[row]! + nameOff[row]! - 1
    return this.decoder.decode(pathBlob.subarray(pathStart[row]!, end))
  }

  typeName(row: number): string {
    // typeId 0 is a legitimate type - it is whichever type the first line
    // used - so this cannot fall back on falsiness.
    return this.cols.types[this.cols.typeId[row]!] ?? 'Unknown'
  }

  row(index: number) {
    const kind = this.cols.kind[index]!
    return {
      index,
      address: this.cols.addr[index]!,
      type: this.typeName(index),
      typeId: this.cols.typeId[index]!,
      path: this.path(index),
      name: this.name(index),
      container: this.container(index),
      outer: this.cols.outer[index]!,
      offset: this.cols.offset[index]!,
      kind,
      // Only meaningful on enum constants; i64, so it prints rather than maths.
      value: kind === KIND_ENUM ? this.cols.value[index]! : null,
    }
  }

  // ---------------------------------------------------------------- matching

  // rootOff is 0 for every path that already starts with '/', which is nearly
  // all of them, so the old `!rootOff[row]` guard rejected everything except
  // array/map inner properties.
  private hasPrefix(row: number, pat: Uint8Array): boolean {
    const { pathStart, pathBlob, rootOff } = this.cols
    const s = pathStart[row]! + rootOff[row]!
    if (pathStart[row + 1]! - s < pat.length) return false
    for (let k = 0; k < pat.length; k++) {
      if (fold(pathBlob[s + k]!) !== pat[k]) return false
    }
    return true
  }

  private hasSub(row: number, pat: Uint8Array, fromName: boolean): boolean {
    const { pathStart, pathBlob, nameOff } = this.cols
    const s = pathStart[row]! + (fromName ? nameOff[row]! : 0)
    const e = pathStart[row + 1]!

    const m = pat.length
    if (m === 0) return true
    const last = e - m
    const first = pat[0]
    for (let i = s; i <= last; i++) {
      if (fold(pathBlob[i]!) !== first) continue
      let k = 1
      while (k < m && fold(pathBlob[i + k]!) === pat[k]) k++
      if (k === m) return true
    }
    return false
  }

  // ------------------------------------------------------------------ query

  /**
   * Single linear pass over every row. At 800k rows this is single-digit
   * milliseconds for type filters and ~40 ms for a substring scan, which is
   * why there is no inverted index here — it would cost more to maintain
   * than it saves.
   */
  query(q: Query): { rows: Uint32Array; typeCounts: Int32Array } {
    const { count, typeId, types } = this.cols
    const typeCounts = new Int32Array(types.length)

    let typeMask: Uint8Array | null = null
    if (q.typeIds && q.typeIds.length) {
      typeMask = new Uint8Array(types.length)
      for (const t of q.typeIds) typeMask[t] = 1
    }

    const prefix = q.pathPrefix ? encodeLower(q.pathPrefix) : null
    const nameSub = q.nameContains ? encodeLower(q.nameContains) : null
    const pathSub = q.pathContains ? encodeLower(q.pathContains) : null

    const out = new Uint32Array(count)
    let n = 0

    for (let i = 0; i < count; i++) {
      if (prefix && !this.hasPrefix(i, prefix)) continue
      if (nameSub && !this.hasSub(i, nameSub, true)) continue
      if (pathSub && !this.hasSub(i, pathSub, false)) continue
      // Facet counts reflect everything *except* the type filter, so the
      // type list stays usable while a type filter is active.
      typeCounts[typeId[i]!]++
      if (typeMask && !typeMask[typeId[i]!]) continue
      out[n++] = i
    }

    const rows = out.subarray(0, n)
    return { rows: this.sort(rows, q), typeCounts }
  }

  private sort(rows: Uint32Array, q: Query): Uint32Array {
    const mode = q.sort ?? 'natural'
    if (mode === 'natural' && !q.descending) return rows
    const { addr, offset } = this.cols

    let cmp: (a: number, b: number) => number
    if (mode === 'address') cmp = (a, b) => addr[a]! - addr[b]! || a - b
    else if (mode === 'offset') cmp = (a, b) => offset[a]! - offset[b]! || a - b
    else if (mode === 'path') cmp = (a, b) => this.cmpPath(a, b)
    else if (mode === 'name') cmp = (a, b) => this.cmpName(a, b) || this.cmpPath(a, b)
    else if (mode === 'type') cmp = (a, b) => this.cmpType(a, b) || this.cmpPath(a, b)
    else cmp = (a, b) => a - b

    const sorted = rows.slice().sort(cmp)
    if (q.descending) sorted.reverse()
    return sorted
  }

  /** Byte order over the *indexable* path, so inner properties sort with their array. */
  private cmpPath(a: number, b: number): number {
    const { pathStart, pathBlob, rootOff } = this.cols
    let i = pathStart[a]! + rootOff[a]!
    let j = pathStart[b]! + rootOff[b]!
    const ae = pathStart[a + 1]!
    const be = pathStart[b + 1]!
    while (i < ae && j < be) {
      const d = pathBlob[i++]! - pathBlob[j++]!
      if (d) return d
    }
    return ae - i - (be - j)
  }

  /**
   * Case-folded byte order over the leaf name. Folding matters here in a way
   * it does not for `cmpPath`: names are the column people read, and raw byte
   * order files every lowercase name after every uppercase one.
   */
  private cmpName(a: number, b: number): number {
    const { pathStart, pathBlob, nameOff } = this.cols
    let i = pathStart[a]! + nameOff[a]!
    let j = pathStart[b]! + nameOff[b]!
    const ae = pathStart[a + 1]!
    const be = pathStart[b + 1]!
    while (i < ae && j < be) {
      const d = fold(pathBlob[i++]!) - fold(pathBlob[j++]!)
      if (d) return d
    }
    return ae - i - (be - j)
  }

  /**
   * Type ids are assigned in first-seen order, so they say nothing about
   * alphabetical order. Rank them once — there are a few hundred types
   * against up to a million rows, so this turns every row comparison into
   * one array lookup.
   */
  private typeRank: Int32Array | null = null
  private cmpType(a: number, b: number): number {
    if (!this.typeRank) {
      const { types } = this.cols
      const order = types.map((_, i) => i)
      order.sort((x, y) => types[x]!.localeCompare(types[y]!))
      const rank = new Int32Array(types.length)
      order.forEach((id, r) => (rank[id] = r))
      this.typeRank = rank
    }
    const { typeId } = this.cols
    return this.typeRank[typeId[a]!]! - this.typeRank[typeId[b]!]!
  }

  // tree

  /**
   * One comparator sort of the whole table. ~2 s at 800k rows; done once.
   *
   * Enum constants are excluded: they have no package path, so including them
   * grouped 15k rows under a junk root.
   */
  private ensurePathOrder(): Uint32Array {
    if (this.byPath) return this.byPath
    const { count, kind } = this.cols
    const idx = new Uint32Array(count)
    let n = 0
    for (let i = 0; i < count; i++) if (kind[i] !== KIND_ENUM) idx[n++] = i
    const trimmed = idx.subarray(0, n)
    trimmed.sort((a, b) => this.cmpPath(a, b))
    this.byPath = trimmed
    return trimmed
  }

  private cmpPrefix(row: number, pat: Uint8Array): number {
    const { pathStart, pathBlob, rootOff } = this.cols
    const s = pathStart[row]! + rootOff[row]!
    const e = pathStart[row + 1]!
    for (let k = 0; k < pat.length; k++) {
      if (s + k >= e) return -1
      const d = pathBlob[s + k]! - pat[k]!
      if (d) return d < 0 ? -1 : 1
    }
    return 0
  }

  /** Half-open range of path-ordered rows whose indexable path starts with `pat`. */
  private range(pat: Uint8Array): [number, number] {
    const order = this.ensurePathOrder()
    let lo = 0
    let hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cmpPrefix(order[mid]!, pat) < 0) lo = mid + 1
      else hi = mid
    }
    const start = lo
    hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cmpPrefix(order[mid]!, pat) <= 0) lo = mid + 1
      else hi = mid
    }
    return [start, lo]
  }

  private childCache = new Map<string, TreeChild[]>()

  /**
   * Direct children of a path prefix.
   *
   * The binary search only bounds the scan; the grouping itself is linear.
   * Jumping block-to-block looks tempting because the rows are sorted, but
   * segments are not reliably contiguous: `.` (0x2E) and `:` (0x3A) straddle
   * the digits, so `/Script/Engine.Actor:Tick`, `/Script/Engine.Actor2` and
   * `/Script/Engine.Actor.Sub` interleave. Linear + cached is correct and,
   * at a few million byte comparisons, fast enough that it does not matter.
   */
  children(prefix: string): TreeChild[] {
    const cached = this.childCache.get(prefix)
    if (cached) return cached

    const order = this.ensurePathOrder()
    const { pathStart, pathBlob, rootOff } = this.cols
    const patBytes = new TextEncoder().encode(prefix)
    const base = patBytes.length
    const [lo, hi] = prefix ? this.range(patBytes) : [0, order.length]

    const groups = new Map<string, TreeChild>()
    for (let n = lo; n < hi; n++) {
      const row = order[n]!
      const s = pathStart[row]! + rootOff[row]!
      const e = pathStart[row + 1]!
      if (s + base >= e) continue // object sitting exactly at the prefix
      const sep = pathBlob[s + base]!
      let k = s + base + 1
      while (k < e && pathBlob[k] !== COLON && pathBlob[k] !== DOT && pathBlob[k] !== SLASH) k++

      let seg = ''
      for (let m = s + base + 1; m < k; m++) seg += String.fromCharCode(pathBlob[m]!)
      const key = String.fromCharCode(sep) + seg

      let node = groups.get(key)
      if (!node) {
        node = {
          segment: seg,
          separator: String.fromCharCode(sep),
          path: prefix + key,
          count: 0,
          isObject: false,
        }
        groups.set(key, node)
      }
      node.count++
      if (k === e) node.isObject = true
    }

    const out = [...groups.values()].sort(
      (a, b) => b.count - a.count || a.segment.localeCompare(b.segment),
    )
    this.childCache.set(prefix, out)
    return out
  }

  /** Resolve a `[or:]` / `[owr:]` pointer back to a row. Built on demand. */
  private addrIndex: Map<number, number> | null = null
  rowByAddress(address: number): number {
    if (!this.addrIndex) {
      this.addrIndex = new Map()
      // Enum constants and recovered fragments all carry address 0; indexing
      // them would make every null pointer resolve to an arbitrary row.
      for (let i = 0; i < this.cols.count; i++) {
        const a = this.cols.addr[i]!
        if (a) this.addrIndex.set(a, i)
      }
    }
    if (!address) return -1
    return this.addrIndex.get(address) ?? -1
  }
}
