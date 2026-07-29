import type { DumpColumns } from './dump-parse'

const DB = 'pdx'
const STORE = 'dumps'
const VERSION = 1

export interface CachedDump {
  key: string
  label: string
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

/**
 * Identity for a dump. Size plus a sparse byte sample: reading 60 MB to hash it properly costs more than re-parsing, and two dumps that agree on size and 64 spread samples are the same dump for our purposes.
 */
export function fingerprint(name: string, buf: Uint8Array): string {
  let h = 0x811c9dc5
  const step = Math.max(1, Math.floor(buf.length / 64))
  for (let i = 0; i < buf.length; i += step) h = Math.imul(h ^ buf[i], 0x01000193)
  return `${name}:${buf.length}:${(h >>> 0).toString(16)}`
}

/** Typed arrays survive structured clone, so there is no serialisation step. */
export const saveDump = (d: CachedDump) => tx('readwrite', (s) => s.put(d))
export const loadDump = (key: string) => tx<CachedDump | undefined>('readonly', (s) => s.get(key))
export const listDumps = () => tx<CachedDump[]>('readonly', (s) => s.getAll())
export const dropDump = (key: string) => tx('readwrite', (s) => s.delete(key))
