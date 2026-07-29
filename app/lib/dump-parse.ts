/**
 * Byte-level tokenizer for UE4SS `DumpObjects` output.
 *
 * Why? Because the dump is huge, and parsing it into a structured object graph is slow and memory-hungry.
 * Instead, we parse it into a compact columnar representation that can be queried efficiently.
 *
 * There is more than one line shape in the file. Three, in the 292k-line dump:
 *
 *   1. Objects        [ADDR] TypeName ObjectPath [k: v] [k: v] ...
 *   2. Enum constants [0000000000000000] EnumName::ValueName [n: HEX] [v: DECIMAL]
 *   3. Damaged lines  UE4SS truncates a record mid-write and resumes on the
 *                     next line, leaving one line with no trailing groups and
 *                     one with no `[ADDR]` prefix.
 *
 * Two things make shape 1 harder than it looks:
 *
 *   - ObjectPath CAN contain spaces (`... (Director BP)_C:UberGraphFrame`,
 *     `Default__SkyCreator:Sun Light Component`) - 5.6k lines' worth. So the
 *     path is not "up to the first space"; the trailing `[k: v]` groups have
 *     to be peeled off the RIGHT and the path is whatever is left.
 *   - Enum constants have no path at all, so a left-to-right scan reads the
 *     first group as the path and files 15k objects under a bogus `[n` root.
 *
 * Peeling from the right is only safe because no object path in the dump
 * contains `[` or `]`; that is asserted by treating a leftover bracket in the
 * path region as damage rather than as text.
 */

const NL = 0x0a
const CR = 0x0d
const LB = 0x5b // [
const RB = 0x5d // ]
const SP = 0x20
const COLON = 0x3a
const DOT = 0x2e
const SLASH = 0x2f
const MINUS = 0x2d

/** Row kinds. `kind` is what keeps enum constants out of the package tree. */
export const KIND_OBJECT = 0
export const KIND_ENUM = 1
export const KIND_DAMAGED = 2

/** Synthetic type for enum constants written without an `EnumName::` qualifier. */
const BARE_ENUM_TYPE = 'EnumConstant'

export interface DumpColumns {
  count: number
  addr: Float64Array // UObject address. 48-bit in practice, so it survives as an f64 exactly.
  typeId: Uint16Array // Index into `types`.
  types: string[]
  pathStart: Uint32Array
  pathBlob: Uint8Array
  nameOff: Uint16Array //  Byte offset from pathStart[i] at which the leaf name begins.
  /**
   *
   * rootOff:
   *
   * Byte offset at which the real `/...` path begins. Array inner properties
   * are dumped as `ComponentTags./Script/Engine.ActorComponent:ComponentTags`;
   * that leading qualifier is kept for display but skipped when indexing, so
   * the inner property files under its array rather than at the tree root.
   */
  rootOff: Uint16Array
  outer: Float64Array // Address from `or:` (outer) or `owr:` (owner), whichever the line carried. 0 = none.
  offset: Int32Array // field offset, or -1 when the line had none.
  kind: Uint8Array // KIND_OBJECT | KIND_ENUM | KIND_DAMAGED.
  /**
   * `v:` on enum constants. i64 because four of them are 2^50..2^56 bit flags
   * and one (2^56+1) is not representable exactly as an f64.
   */
  value: BigInt64Array
  skipped: number // Lines that carried no usable record at all.
  damaged: number // Rows recovered from a truncated line; their groups are gone.
}

function hexAt(b: Uint8Array, i: number, end: number): number {
  let v = 0
  for (; i < end; i++) {
    const c = b[i]!
    if (c >= 0x30 && c <= 0x39) v = v * 16 + (c - 0x30)
    else if (c >= 0x61 && c <= 0x66) v = v * 16 + (c - 0x57)
    else if (c >= 0x41 && c <= 0x46) v = v * 16 + (c - 0x37)
    else break
  }
  return v
}

/** `v:` is decimal and signed, unlike every other value in the file. */
function decAt(b: Uint8Array, i: number, end: number): bigint {
  let neg = false
  if (i < end && b[i] === MINUS) {
    neg = true
    i++
  }
  let v = 0n
  for (; i < end; i++) {
    const c = b[i]!
    if (c < 0x30 || c > 0x39) break
    v = v * 10n + BigInt(c - 0x30)
  }
  return neg ? -v : v
}

const isAlpha = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)

export function parseDump(  src: Uint8Array, onProgress?: (fraction: number) => void): DumpColumns {

  const len = src.length

  let lines = 0
  for (let i = 0; i < len; i++) if (src[i] === NL) lines++
  if (len > 0 && src[len - 1] !== NL) lines++

  const addr = new Float64Array(lines)
  const typeId = new Uint16Array(lines)
  const pathStart = new Uint32Array(lines + 1)
  const nameOff = new Uint16Array(lines)
  const rootOff = new Uint16Array(lines)
  const outer = new Float64Array(lines)
  const offset = new Int32Array(lines)
  const kind = new Uint8Array(lines)
  const value = new BigInt64Array(lines)
  const pathBlob = new Uint8Array(len)  // Upper bound.

  const types: string[] = []
  // hash -> type id. Collision risk across distinct type names is nil and skipping the decode here is worth several hundred ms.
  const typeIndex = new Map<number, number>()
  const decoder = new TextDecoder()

  /** Intern a type name held as a byte range. */
  function internRange(s: number, end: number): number {
    let h = 0x811c9dc5
    for (let k = s; k < end; k++) h = Math.imul(h ^ src[k]!, 0x01000193)
    h = (h ^ (end - s)) >>> 0
    let id = typeIndex.get(h)
    if (id === undefined) {
      id = types.length
      types.push(decoder.decode(src.subarray(s, end)))
      typeIndex.set(h, id)
    }
    return id
  }

  /** Intern a type name we synthesised rather than read. */
  const synthetic = new Map<string, number>()
  function internString(name: string): number {
    let id = synthetic.get(name)
    if (id === undefined) {
      id = types.length
      types.push(name)
      synthetic.set(name, id)
    }
    return id
  }

  let row = 0
  let w = 0
  let skipped = 0
  let damaged = 0
  let i = 0
  let nextProgress = len >> 5

  while (i < len) {
    let lineEnd = i
    while (lineEnd < len && src[lineEnd] !== NL) lineEnd++
    let e = lineEnd
    if (e > i && src[e - 1] === CR) e--

    let p = i
    i = lineEnd + 1

    if (onProgress && p > nextProgress) {
      onProgress(p / len)
      nextProgress = p + (len >> 5)
    }

    while (p < e && src[p] === SP) p++
    if (p >= e) continue // blank

    // --- address ---
    // A truncated continuation line has no `[ADDR]`; it still names a real
    // object, so recover it with a null address rather than dropping it.
    let address = 0
    let isFragment = false
    if (src[p] === LB) {
      let q = p + 1
      while (q < e && src[q] !== RB) q++
      if (q >= e) {
        skipped++
        continue
      }
      address = hexAt(src, p + 1, q)
      p = q + 1
    } else {
      isFragment = true
    }
    while (p < e && src[p] === SP) p++

    // --- type name ---
    const tStart = p
    while (p < e && src[p] !== SP) p++
    const tEnd = p
    if (tEnd === tStart) {
      skipped++
      continue
    }
    while (p < e && src[p] === SP) p++

    // --- trailing [key: value] groups, peeled right to left ---
    const bodyStart = p
    let outerV = 0
    let offsetV = -1
    let valueV = 0n
    let hasValue = false
    let groupsAt = e

    for (;;) {
      let s = groupsAt
      while (s > bodyStart && src[s - 1] === SP) s--
      if (s <= bodyStart || src[s - 1] !== RB) break

      // No object path contains a bracket, so the nearest '[' opens this group.
      let open = s - 2
      while (open >= bodyStart && src[open] !== LB) open--
      if (open < bodyStart) break

      // Must look like `key: value` with a short alphabetic key.
      let k = open + 1
      while (k < s - 1 && isAlpha(src[k]!)) k++
      if (k === open + 1 || k - (open + 1) > 6 || k >= s - 1 || src[k] !== COLON) break

      const kStart = open + 1
      const kLen = k - kStart
      let vStart = k + 1
      while (vStart < s - 1 && src[vStart] === SP) vStart++
      const vEnd = s - 1

      if (kLen === 1 && src[kStart] === 0x6f) {
        offsetV = hexAt(src, vStart, vEnd) // o: field offset
      } else if (kLen === 1 && src[kStart] === 0x76) {
        valueV = decAt(src, vStart, vEnd) // v: enum constant
        hasValue = true
      } else if (kLen === 2 && src[kStart] === 0x6f && src[kStart + 1] === 0x72) {
        outerV = hexAt(src, vStart, vEnd) // or: outer
      } else if (
        kLen === 3 &&
        src[kStart] === 0x6f &&
        src[kStart + 1] === 0x77 &&
        src[kStart + 2] === 0x72
      ) {
        outerV = hexAt(src, vStart, vEnd) // owr: owner
      }

      groupsAt = open
    }

    // --- object path: everything between the type name and the first group ---
    const pStart = bodyStart
    let pEnd = groupsAt
    while (pEnd > pStart && src[pEnd - 1] === SP) pEnd--

    // A bracket surviving in the path region means the line was cut mid-group.
    let rowKind = isFragment ? KIND_DAMAGED : KIND_OBJECT
    for (let k = pStart; k < pEnd; k++) {
      if (src[k] === LB || src[k] === RB) {
        pEnd = k
        while (pEnd > pStart && src[pEnd - 1] === SP) pEnd--
        rowKind = KIND_DAMAGED
        outerV = 0
        offsetV = -1
        break
      }
    }

    let tid: number
    if (pEnd === pStart) {
      // No path: an enum constant, `EnumName::ValueName` or a bare `CIM_Linear`.
      // The qualifier is the useful facet, so it becomes the type and the whole
      // token becomes the path, which gives the row a searchable leaf name.
      rowKind = KIND_ENUM
      let sep = -1
      for (let k = tStart; k + 1 < tEnd; k++) {
        if (src[k] === COLON && src[k + 1] === COLON) {
          sep = k
          break
        }
      }
      tid = sep < 0 ? internString(BARE_ENUM_TYPE) : internRange(tStart, sep)
      pathBlob.set(src.subarray(tStart, tEnd), w)
      // Leaf name is the part after `::`.
      nameOff[row] = sep < 0 ? 0 : sep + 2 - tStart
      rootOff[row] = 0
      pathStart[row] = w
      w += tEnd - tStart
    } else {
      tid = internRange(tStart, tEnd)

      // --- indexable root: skip a leading `Qualifier.` before the first '/' ---
      let r = pStart
      if (r < pEnd && src[r] !== SLASH) {
        let k = r
        while (k < pEnd && src[k] !== SLASH) k++
        if (k < pEnd) r = k
      }

      // --- leaf name: last '/', '.' or ':' ---
      let n = pEnd
      while (n > pStart) {
        const c = src[n - 1]
        if (c === COLON || c === DOT || c === SLASH) break
        n--
      }

      pathStart[row] = w
      nameOff[row] = Math.min(n - pStart, 0xffff)
      rootOff[row] = Math.min(r - pStart, 0xffff)
      pathBlob.set(src.subarray(pStart, pEnd), w)
      w += pEnd - pStart
    }

    if (rowKind === KIND_DAMAGED) damaged++

    addr[row] = address
    typeId[row] = tid
    outer[row] = outerV
    offset[row] = offsetV
    kind[row] = rowKind
    value[row] = hasValue ? valueV : 0n
    row++
  }

  pathStart[row] = w
  onProgress?.(1)

  return {
    count: row,
    addr: addr.subarray(0, row),
    typeId: typeId.subarray(0, row),
    types,
    pathStart: pathStart.subarray(0, row + 1),
    pathBlob: pathBlob.slice(0, w),
    nameOff: nameOff.subarray(0, row),
    rootOff: rootOff.subarray(0, row),
    outer: outer.subarray(0, row),
    offset: offset.subarray(0, row),
    kind: kind.subarray(0, row),
    value: value.subarray(0, row),
    skipped,
    damaged,
  }
}
