import type { DumpColumns } from './dump-parse'

/**
 * A parsed dump serialised as one flat file.
 *
 *   [0..4)   magic
 *   [4..8)   manifest length in bytes
 *   [8..12)  payload base offset
 *   [12..16) reserved
 *   [16..)   JSON manifest, then zero padding, then the column buffers
 *
 * The payload offset lives in the fixed header rather than the manifest so
 * that writing it cannot change the manifest's own length.
 *
 * This exists for the case where the dump ships with the site instead of
 * being uploaded. Parse once at build time and the browser does one fetch
 * plus a few typed-array views over the response - no parsing, no IndexedDB.
 * It also gzips far better than JSON, because each column is homogeneous.
 */

// Bumped to \x02 when `kind` and `value` were added; a \x01 bundle has no way
// to tell enum constants from objects, so it is rejected rather than upgraded.
const MAGIC = 0x50445802 // "PDX\x02"
const MAGIC_V1 = 0x50445801
const HEADER = 16

const COLUMNS = [
  ['addr', Float64Array],
  ['typeId', Uint16Array],
  ['pathStart', Uint32Array],
  ['pathBlob', Uint8Array],
  ['nameOff', Uint16Array],
  ['rootOff', Uint16Array],
  ['outer', Float64Array],
  ['offset', Int32Array],
  ['kind', Uint8Array],
  ['value', BigInt64Array],
] as const

const align8 = (n: number) => (8 - (n % 8)) % 8

export function encodeBundle(cols: DumpColumns): Uint8Array {
  const layout: Record<string, { offset: number; length: number }> = {}
  const parts: { at: number; bytes: Uint8Array }[] = []
  let size = 0

  for (const [key] of COLUMNS) {
    const view = cols[key] as ArrayBufferView & { length: number }
    size += align8(size)
    layout[key] = { offset: size, length: view.length }
    parts.push({
      at: size,
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    })
    size += view.byteLength
  }

  const json = new TextEncoder().encode(
    JSON.stringify({
      count: cols.count,
      types: cols.types,
      skipped: cols.skipped,
      damaged: cols.damaged,
      columns: layout,
    }),
  )
  const base = HEADER + json.length + align8(HEADER + json.length)

  const out = new Uint8Array(base + size)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, json.length, true)
  dv.setUint32(8, base, true)
  out.set(json, HEADER)
  for (const { at, bytes } of parts) out.set(bytes, base + at)
  return out
}

export function decodeBundle(buf: ArrayBuffer): DumpColumns {
  const dv = new DataView(buf)
  const magic = dv.getUint32(0, true)
  if (magic === MAGIC_V1) {
    throw new Error('This .pdx was built by an older parser. Re-run `npm run prebake`.')
  }
  if (magic !== MAGIC) throw new Error('Not a .pdx bundle.')
  const jsonLen = dv.getUint32(4, true)
  const base = dv.getUint32(8, true)
  const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, HEADER, jsonLen)))

  const cols: Record<string, unknown> = {
    count: manifest.count,
    types: manifest.types,
    skipped: manifest.skipped,
    damaged: manifest.damaged ?? 0,
  }
  for (const [key, Ctor] of COLUMNS) {
    const { offset, length } = manifest.columns[key]
    cols[key] = new Ctor(buf, base + offset, length)
  }
  return cols as unknown as DumpColumns
}
