import { KIND_ENUM, type DumpColumns } from './dump-parse'

const COLON = 0x3a
const DOT = 0x2e
const SLASH = 0x2f

/** `natural` is dump order — the order the lines appeared in the file. */
export type SortKey = 'natural' | 'path' | 'address' | 'offset' | 'name' | 'type'

/**
 * What a row is *for*, as far as nesting and display care.
 *
 * `param` / `return` / `local` only apply to properties owned by a function.
 * The dump carries no CPF_Parm flags, so they are told apart by name: native
 * functions name their return `ReturnValue`, while Blueprint functions also
 * own frame temporaries — `CallFunc_X_ReturnValue` holds the result of a call
 * to X, it is *not* this function's return — prefixed as below.
 */
export const ROLES = [
  'object',
  'package',
  'class',
  'struct',
  'function',
  'member',
  'param',
  'return',
  'local',
] as const
export type Role = (typeof ROLES)[number]

const R_OBJECT = 0
const R_PACKAGE = 1
const R_CLASS = 2
const R_STRUCT = 3
const R_FUNCTION = 4
const R_MEMBER = 5
const R_PARAM = 6
const R_RETURN = 7
const R_LOCAL = 8

const FUNCTION_TYPES = new Set(['Function', 'DelegateFunction', 'SparseDelegateFunction'])
const LOCAL_PREFIXES = ['CallFunc_', 'K2Node_', 'Temp_']

function typeRole(type: string): number {
  if (type === 'Package') return R_PACKAGE
  if (type === 'Class' || type.endsWith('GeneratedClass')) return R_CLASS
  if (type === 'ScriptStruct' || type === 'UserDefinedStruct') return R_STRUCT
  if (FUNCTION_TYPES.has(type)) return R_FUNCTION
  if (type.endsWith('Property')) return R_MEMBER
  return R_OBJECT
}

/** Ownership chains in the dump top out at 14; anything longer is a cycle. */
const MAX_CHAIN = 64

export interface Nested {
  /** Display order: every match plus the owners that give it context. */
  rows: Uint32Array
  /** True nesting depth per display row. The table clamps the indent. */
  depth: Uint8Array
  /** 1 where the row is shown only as a match's owner, not as a match. */
  ctx: Uint8Array
  /** Rows that actually matched the query. */
  matches: number
}

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
  /** Row indices ordered by path bytes. */
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


  name(row: number): string {
    const { pathStart, pathBlob, nameOff } = this.cols
    return this.decoder.decode(
      pathBlob.subarray(pathStart[row]! + nameOff[row]!, pathStart[row + 1]!),
    )
  }

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
      role: this.role(index),
      group: this.groupOf(index),
    }
  }

  // --- ownership

  /** Row of each row's `or:`/`owr:` owner, or -1. */
  private parent: Int32Array | null = null
  private roles: Uint8Array | null = null
  /** Owned rows per owner, in dump order: kidList[kidStart[r] .. kidStart[r + 1]). */
  private kidStart: Uint32Array | null = null
  private kidList: Uint32Array | null = null

  /**
   * One linear pass over the owner pointers. Derived rather than stored, so
   * cached dumps and `.pdx` bundles from before this existed still load.
   */
  private ensureOwnership() {
    if (this.parent) return
    const { count, outer, typeId, types } = this.cols

    const parent = new Int32Array(count).fill(-1)
    for (let i = 0; i < count; i++) {
      const p = this.rowByAddress(outer[i]!)
      if (p >= 0 && p !== i) parent[i] = p
    }
    // UE ownership is a tree, but a damaged line or a reused address could
    // still close a loop, and every walk below assumes one cannot happen.
    for (let i = 0; i < count; i++) {
      let p = parent[i]!
      let steps = 0
      while (p >= 0 && ++steps < MAX_CHAIN) p = parent[p]!
      if (steps >= MAX_CHAIN) parent[i] = -1
    }

    const byType = Uint8Array.from(types, typeRole)
    const roles = new Uint8Array(count)
    for (let i = 0; i < count; i++) roles[i] = byType[typeId[i]!]!
    for (let i = 0; i < count; i++) {
      const p = parent[i]!
      if (roles[i] !== R_MEMBER || p < 0 || roles[p] !== R_FUNCTION) continue
      const name = this.name(i)
      roles[i] =
        name === 'ReturnValue'
          ? R_RETURN
          : LOCAL_PREFIXES.some((s) => name.startsWith(s))
            ? R_LOCAL
            : R_PARAM
    }

    const kidStart = new Uint32Array(count + 1)
    for (let i = 0; i < count; i++) {
      const p = parent[i]!
      if (p >= 0) kidStart[p + 1] = kidStart[p + 1]! + 1
    }
    for (let i = 0; i < count; i++) kidStart[i + 1] = kidStart[i + 1]! + kidStart[i]!
    const fill = kidStart.slice(0, count)
    const kidList = new Uint32Array(kidStart[count]!)
    for (let i = 0; i < count; i++) if (parent[i]! >= 0) kidList[fill[parent[i]!]!++] = i

    this.parent = parent
    this.roles = roles
    this.kidStart = kidStart
    this.kidList = kidList
  }

  role(row: number): Role {
    this.ensureOwnership()
    return ROLES[this.roles![row]!]!
  }

  ownerOf(row: number): number {
    this.ensureOwnership()
    return this.parent![row]!
  }

  /** Rows owned directly by `row`, in dump order. */
  members(row: number): Uint32Array {
    this.ensureOwnership()
    return this.kidList!.subarray(this.kidStart![row]!, this.kidStart![row + 1]!)
  }

  /**
   * Owner for display purposes. Packages are never shown as parents — they
   * are scoped to instead — so whatever a package owns is a top-level row.
   */
  private nestParent(row: number): number {
    const p = this.parent![row]!
    return p < 0 || this.roles![p] === R_PACKAGE ? -1 : p
  }

  /**
   * The row whose selection highlights `row` as one unit: the nearest
   * function, class or struct at or above it, else its top-level ancestor.
   * So a parameter groups with its function, and a class property with the
   * class, without the class pulling every one of its functions in too.
   */
  groupOf(row: number): number {
    this.ensureOwnership()
    const roles = this.roles!
    let r = row
    for (;;) {
      const role = roles[r]
      if (role === R_FUNCTION || role === R_CLASS || role === R_STRUCT) return r
      const p = this.nestParent(r)
      if (p < 0) return r
      r = p
    }
  }

  // --- matching

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

  // --- query


  query(q: Query): Nested & { typeCounts: Int32Array } {
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

    return { ...this.nest(out.subarray(0, n), q), typeCounts }
  }

  /**
   * Matches → display order.
   *
   * Every match pulls in its owner chain (as context rows, when the owner did
   * not match itself), then the result is laid out depth-first. The sort is
   * applied among siblings at every level, so a child never leaves its parent
   * and a group's place is decided by its head alone. The one exception is a
   * function's children, which always stay in offset order: that order *is*
   * the params struct, and it is the reason to look at a function at all.
   */
  private nest(match: Uint32Array, q: Query): Nested {
    this.ensureOwnership()
    const { count, offset } = this.cols
    const roles = this.roles!

    // 1 = matched, 2 = owner of a match shown for context.
    const inc = new Uint8Array(count)
    for (let k = 0; k < match.length; k++) inc[match[k]!] = 1
    for (let k = 0; k < match.length; k++) {
      let p = this.nestParent(match[k]!)
      while (p >= 0 && !inc[p]) {
        inc[p] = 2
        p = this.nestParent(p)
      }
    }

    // Children per included parent, CSR over row ids. Filled in row order, so
    // natural order needs no sort at all.
    const start = new Uint32Array(count + 1)
    let total = 0
    let roots = 0
    for (let i = 0; i < count; i++) {
      if (!inc[i]) continue
      total++
      const p = this.nestParent(i)
      if (p < 0) roots++
      else start[p + 1] = start[p + 1]! + 1
    }
    for (let i = 0; i < count; i++) start[i + 1] = start[i + 1]! + start[i]!
    const fill = start.slice(0, count)
    const kids = new Uint32Array(start[count]!)
    const top = new Uint32Array(roots)
    roots = 0
    for (let i = 0; i < count; i++) {
      if (!inc[i]) continue
      const p = this.nestParent(i)
      if (p < 0) top[roots++] = i
      else kids[fill[p]!++] = i
    }

    const cmp = this.comparator(q)
    const byOffset = (a: number, b: number) => offset[a]! - offset[b]! || a - b
    if (cmp) top.sort(cmp)
    for (let p = 0; p < count; p++) {
      const s = start[p]!
      const e = start[p + 1]!
      if (e - s < 2) continue
      if (roles[p] === R_FUNCTION) kids.subarray(s, e).sort(byOffset)
      else if (cmp) kids.subarray(s, e).sort(cmp)
    }

    // Depth-first, iteratively: chains are shallow but there are many of them.
    const rows = new Uint32Array(total)
    const depth = new Uint8Array(total)
    const ctx = new Uint8Array(total)
    const stack: number[] = []
    const stackDepth: number[] = []
    let n = 0
    for (let t = 0; t < top.length; t++) {
      stack.push(top[t]!)
      stackDepth.push(0)
      while (stack.length) {
        const r = stack.pop()!
        const d = stackDepth.pop()!
        rows[n] = r
        depth[n] = Math.min(d, 255)
        ctx[n] = inc[r] === 2 ? 1 : 0
        n++
        for (let c = start[r + 1]! - 1; c >= start[r]!; c--) {
          stack.push(kids[c]!)
          stackDepth.push(d + 1)
        }
      }
    }

    return { rows, depth, ctx, matches: match.length }
  }

  /**
   * Sibling comparator for the chosen column, or null when dump order stands.
   *
   * Rows without a value — no offset on a class or function, the null address
   * on a recovered fragment — sort last in *both* directions. Otherwise an
   * ascending OFF sort would hoist every group head above every member.
   */
  private comparator(q: Query): ((a: number, b: number) => number) | null {
    const mode = q.sort ?? 'natural'
    if (mode === 'natural' && !q.descending) return null
    const { addr, offset } = this.cols
    const dir = q.descending ? -1 : 1

    let base: (a: number, b: number) => number
    let missing: ((r: number) => boolean) | null = null
    if (mode === 'address') {
      base = (a, b) => addr[a]! - addr[b]!
      missing = (r) => !addr[r]
    } else if (mode === 'offset') {
      base = (a, b) => offset[a]! - offset[b]!
      missing = (r) => offset[r]! < 0
    } else if (mode === 'path') base = (a, b) => this.cmpPath(a, b)
    else if (mode === 'name') base = (a, b) => this.cmpName(a, b) || this.cmpPath(a, b)
    else if (mode === 'type') base = (a, b) => this.cmpType(a, b) || this.cmpPath(a, b)
    else base = (a, b) => a - b

    if (!missing) return (a, b) => dir * base(a, b) || a - b
    const m = missing
    return (a, b) => {
      const ma = m(a)
      if (ma !== m(b)) return ma ? 1 : -1
      return dir * base(a, b) || a - b
    }
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

  /**
   * Every row at exactly `prefix` or beneath it, in path order.
   */
  subtree(prefix: string): Uint32Array {
    const order = this.ensurePathOrder()
    if (!prefix) return order.slice()

    const pat = new TextEncoder().encode(prefix)
    const [lo, hi] = this.range(pat)
    const { pathStart, pathBlob, rootOff } = this.cols

    const out = new Uint32Array(hi - lo)
    let n = 0
    for (let i = lo; i < hi; i++) {
      const row = order[i]!
      const after = pathStart[row]! + rootOff[row]! + pat.length
      const end = pathStart[row + 1]!
      if (after > end) continue
      const c = pathBlob[after]
      if (after === end || c === SLASH || c === DOT || c === COLON) out[n++] = row
    }
    return out.slice(0, n)
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
