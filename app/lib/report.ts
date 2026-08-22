import type { DumpStore } from './dump-store'
import { KIND_ENUM } from './dump-parse'

/**
 * A subtree rendered as a reference sheet for writing reflection code.
 *
 * The audience is someone about to hook a UFunction: they need the object
 * path to look it up, and the parameter layout — names, types, and byte
 * offsets in declaration order — to lay out the params struct the hook
 * receives. So the report is two passes over the same rows. The outline
 * answers "what is in here", and the detail section answers "what do I have
 * to write", with functions given the offset table that is the whole point.
 */

const FUNCTION_TYPES = new Set(['Function', 'DelegateFunction', 'SparseDelegateFunction'])

/** Beyond this the report stops being a reference and starts being the dump. */
export const REPORT_CAP = 25_000

export interface ReportResult {
  text: string
  objects: number
  truncated: boolean
}

const hex16 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(16, '0')
const hexOff = (n: number) => '+0x' + n.toString(16).toUpperCase().padStart(4, '0')

function stamp(t: number): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = new Date(t)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * The part of a display path that hangs below `root`.
 *
 * Not simply `path.slice(root.length)`. Array and map inner properties are
 * dumped with a leading qualifier — `K2Node_MakeArray_Array./Game/…:UpdateHP`
 * — which the store skips when indexing, so such a row is legitimately inside
 * the subtree while its *displayed* path does not begin with the root at all.
 * Slicing blind turns those lines into garbage at a random offset.
 */
function relativeTo(root: string, path: string): string {
  if (!root) return path
  const at = path.indexOf(root)
  return at < 0 ? path : path.slice(at + root.length)
}

/** Separator depth, for indenting the outline. */
function depthOf(rel: string): number {
  let d = 0
  for (let i = 0; i < rel.length; i++) {
    const c = rel[i]
    if (c === '/' || c === '.' || c === ':') d++
  }
  return d
}

export function buildReport(
  store: DumpStore,
  rows: Uint32Array,
  meta: { root: string; label: string },
): ReportResult {
  const truncated = rows.length > REPORT_CAP
  const used = truncated ? rows.subarray(0, REPORT_CAP) : rows

  // One pass to materialise, because both sections read the same rows and
  // `store.row` decodes strings out of the path blob each time it is called.
  const objs = Array.from(used, (r) => store.row(r))

  // Children are grouped by their container so that a function can find its
  // parameters without a second scan per function.
  const byContainer = new Map<string, typeof objs>()
  for (const o of objs) {
    const list = byContainer.get(o.container)
    if (list) list.push(o)
    else byContainer.set(o.container, [o])
  }

  const out: string[] = []
  const { root, label } = meta

  out.push('UE4SS OBJECT EXPLORER — SUBTREE REPORT')
  out.push('='.repeat(72))
  out.push(`root       ${root || '(everything)'}`)
  out.push(`dump       ${label}`)
  out.push(`objects    ${objs.length.toLocaleString()}${truncated ? ` (capped from ${rows.length.toLocaleString()})` : ''}`)
  out.push(`generated  ${stamp(Date.now())}`)
  if (truncated) {
    out.push('')
    out.push(`NOTE  This subtree holds ${rows.length.toLocaleString()} objects; only the first`)
    out.push(`      ${REPORT_CAP.toLocaleString()} are listed. Scope to a narrower node for a complete report.`)
  }
  out.push('')

  // ------------------------------------------------------------- outline
  out.push('OUTLINE')
  out.push('-'.repeat(72))
  for (const o of objs) {
    const rel = relativeTo(root, o.path)
    const bits = [`${'  '.repeat(depthOf(rel))}${rel || o.path}`]
    // Flag the qualifier rather than dropping it: an inner property listed
    // only by its tail reads as a duplicate of the array it belongs to.
    if (root && !o.path.startsWith(root)) bits.push(`(inner of ${o.path.slice(0, o.path.indexOf(root))})`)
    bits.push(`· ${o.type}`)
    if (o.address) bits.push(`@ ${hex16(o.address)}`)
    if (o.offset >= 0) bits.push(hexOff(o.offset))
    if (o.kind === KIND_ENUM && o.value !== null) bits.push(`= ${o.value}`)
    out.push(bits.join('  '))
  }
  out.push('')

  // ------------------------------------------------------------ functions
  const fns = objs.filter((o) => FUNCTION_TYPES.has(o.type))
  if (fns.length) {
    out.push('FUNCTIONS')
    out.push('-'.repeat(72))
    out.push(`${fns.length} callable${fns.length === 1 ? '' : 's'} in this subtree.`)
    out.push('')

    for (const f of fns) {
      // Declaration order is offset order: UE lays parameters out in the
      // params struct in the order they are declared, return value last.
      const params = (byContainer.get(f.path) ?? []).slice().sort((a, b) => a.offset - b.offset)

      out.push(f.path)
      out.push(`  name      ${f.name}`)
      out.push(`  type      ${f.type}`)
      out.push(`  address   ${hex16(f.address)}`)
      if (f.outer) out.push(`  outer     ${hex16(f.outer)}`)
      if (!params.length) {
        out.push('  params    none')
      } else {
        out.push(`  params    ${params.length}`)
        const w = Math.max(...params.map((p) => p.name.length), 4)
        out.push(`    ${'OFFSET'.padEnd(9)}${'NAME'.padEnd(w + 2)}TYPE`)
        for (const p of params) {
          out.push(`    ${hexOff(p.offset).padEnd(9)}${p.name.padEnd(w + 2)}${p.type}`)
        }
      }
      out.push('')
    }
  }

  // --------------------------------------------------------------- objects
  out.push('OBJECTS')
  out.push('-'.repeat(72))
  for (const o of objs) {
    out.push(o.path)
    out.push(`  type      ${o.type}`)
    out.push(`  address   ${hex16(o.address)}`)
    if (o.outer) out.push(`  outer     ${hex16(o.outer)}`)
    if (o.offset >= 0) out.push(`  offset    ${hexOff(o.offset)} (${o.offset})`)
    if (o.kind === KIND_ENUM && o.value !== null) out.push(`  value     ${o.value}`)
    out.push('')
  }

  return { text: out.join('\n'), objects: objs.length, truncated }
}
