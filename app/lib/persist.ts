import type { DumpColumns } from './dump-parse'

const DB = 'pdx'
const STORE = 'dumps'
const VERSION = 1

export interface CachedDump {
  /** Content hash. Stable across machines, so it is safe to put in a URL. */
  key: string
  /** Display title: the original file name plus the moment it was parsed. */
  label: string
  /** File name as it arrived, without the datetime suffix. */
  name: string
  /** Manifest id when this came from the site's own dump list, else absent. */
  source?: string
  bytes: number
  parsedAt: number
  cols: DumpColumns
}

let conn: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (conn) return conn
  conn = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      conn = null
      reject(req.error)
    }
  })
  return conn
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

const PRIME = 0x01000193

/** Final avalanche, so that near-identical lane states diverge in the output. */
function mix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Identity for a dump: 64 bits of FNV-1a over every byte of the file, and
 * nothing else.
 *
 * Content-only is the whole point — this hash goes in the URL, so two people
 * holding the same file must derive the same id from it. That rules out the
 * file name (people rename dumps) and the parse time. It also rules out the
 * sparse sampling this used to do: a shared link is only as trustworthy as
 * the odds that two different dumps collide, and 64 sampled bytes out of
 * 60 MB is not a bet worth taking when the dumps being compared are near
 * identical by construction (same game, one patch apart).
 *
 * Four interleaved lanes rather than one, because a single-lane FNV over
 * 60 MB is a serial dependency chain; the lanes let the CPU overlap the
 * multiplies. Costs ~100 ms on a 60 MB dump, against ~1 s to parse it.
 */
export function contentHash(buf: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  let c = 0x85ebca6b
  let d = 0xc2b2ae35

  const n = buf.length
  const quads = n - (n % 4)
  let i = 0
  for (; i < quads; i += 4) {
    a = Math.imul(a ^ buf[i]!, PRIME)
    b = Math.imul(b ^ buf[i + 1]!, PRIME)
    c = Math.imul(c ^ buf[i + 2]!, PRIME)
    d = Math.imul(d ^ buf[i + 3]!, PRIME)
  }
  for (; i < n; i++) a = Math.imul(a ^ buf[i]!, PRIME)

  // Length participates too, so that a truncated file cannot land on the
  // same lanes as the whole one.
  const hi = mix(a ^ Math.imul(b, PRIME) ^ n)
  const lo = mix(c ^ Math.imul(d, PRIME) ^ n)
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
}

const stamp = (t: number) => {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = new Date(t)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Titles carry the datetime so two loads of the same file stay tellable apart. */
export const titleFor = (name: string, parsedAt: number) => `${name} · ${stamp(parsedAt)}`

/** Typed arrays survive structured clone, so there is no serialisation step. */
export const saveDump = (d: CachedDump) => tx('readwrite', (s) => s.put(d))
export const loadDump = (key: string) => tx<CachedDump | undefined>('readonly', (s) => s.get(key))
export const listDumps = () => tx<CachedDump[]>('readonly', (s) => s.getAll())
export const dropDump = (key: string) => tx('readwrite', (s) => s.delete(key))
