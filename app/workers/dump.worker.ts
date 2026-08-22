/// <reference lib="webworker" />
import { parseDump } from '../lib/dump-parse'
import { decodeBundle } from '../lib/bundle'
import { DumpStore, type Query } from '../lib/dump-store'
import { buildReport } from '../lib/report'
import { contentHash, titleFor, saveDump, loadDump } from '../lib/persist'

/**
 * The store never crosses to the main thread. The UI asks for a window of
 * rows and gets back ~60 plain objects; the 30–80 MB of columns stay here.
 */
let store: DumpStore | null = null
let current: Uint32Array = new Uint32Array(0)
/** Title of the open dump, so a report can name what it was taken from. */
let currentLabel = ''

type Req =
  | {
      id: number
      op: 'parse'
      buffer: ArrayBuffer
      name: string
      /** 'pdx' skips the parser: the file is already a serialised column set. */
      format?: 'text' | 'pdx'
      /** Manifest id, when this arrived from the site's own dump list. */
      source?: string
    }
  | { id: number; op: 'restore'; key: string }
  | { id: number; op: 'query'; query: Query }
  | { id: number; op: 'window'; start: number; end: number }
  | { id: number; op: 'children'; prefix: string }
  | { id: number; op: 'resolve'; address: number }
  | { id: number; op: 'report'; prefix: string }
  | { id: number; op: 'close' }

function summary() {
  const s = store!
  const { addr, count, types } = s.cols
  let min = Infinity
  let max = 0
  for (let i = 0; i < count; i++) {
    const el = addr[i];
    if(!el) continue
    if (el < min) min = el
    if (el > max) max = el
  }
  // Every address in a dump shares a leading run of hex digits. Finding it
  // lets the table ghost the noise and highlight the digits that differ.
  const a = min.toString(16).padStart(12, '0').toUpperCase()
  const b = max.toString(16).padStart(12, '0').toUpperCase()
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared++
  return { count, types, sharedAddressDigits: shared, skipped: s.cols.skipped }
}

async function handle(msg: Req) {
  switch (msg.op) {
    case 'parse': {
      const src = new Uint8Array(msg.buffer)
      // Hashed before anything else: the id is the file's content, so it is
      // known even for a dump we turn out to already hold.
      const key = contentHash(src)
      const cached = await loadDump(key).catch(() => undefined)
      if (cached) {
        store = new DumpStore(cached.cols)
        currentLabel = cached.label
        return { ...summary(), key, label: cached.label, cached: true }
      }

      const t0 = performance.now()
      const cols =
        msg.format === 'pdx'
          ? decodeBundle(msg.buffer)
          : parseDump(src, (f) => self.postMessage({ id: -1, event: 'progress', fraction: f }))
      const ms = performance.now() - t0

      store = new DumpStore(cols)
      const parsedAt = Date.now()
      const label = titleFor(msg.name, parsedAt)
      currentLabel = label
      await saveDump({
        key,
        label,
        name: msg.name,
        source: msg.source,
        bytes: src.length,
        parsedAt,
        cols,
      }).catch(() => {})
      return { ...summary(), key, label, cached: false, parseMs: ms }
    }

    case 'restore': {
      const cached = await loadDump(msg.key)
      if (!cached) throw new Error('That dump is no longer cached. Load the file again.')
      store = new DumpStore(cached.cols)
      currentLabel = cached.label
      return { ...summary(), key: cached.key, label: cached.label, cached: true }
    }

    case 'query': {
      const t0 = performance.now()
      const { rows, typeCounts } = store!.query(msg.query)
      current = rows
      return { total: rows.length, typeCounts, ms: performance.now() - t0 }
    }

    case 'window': {
      const end = Math.min(msg.end, current.length)
      const out = []
      for (let i = msg.start; i < end; i++) {
        const el = current[i];
        if(!el) continue
        const row = store!.row(el)
        if (row) out.push(row)
      }
      return { start: msg.start, rows: out }
    }

    case 'children':
      return { prefix: msg.prefix, children: store!.children(msg.prefix) }

    case 'resolve': {
      const row = store!.rowByAddress(msg.address)
      return { row: row >= 0 ? store!.row(row) : null }
    }

    // Built here rather than on the main thread: the report walks the whole
    // subtree and decodes a string per field, and only the finished text
    // crosses back.
    case 'report': {
      const s = store!
      const rows = s.subtree(msg.prefix)
      return buildReport(s, rows, { root: msg.prefix, label: currentLabel })
    }

    // Drops the only references to the columns; the dump stays in IndexedDB,
    // so 'restore' can bring it back without re-parsing.
    case 'close': {
      store = null
      current = new Uint32Array(0)
      currentLabel = ''
      return { closed: true }
    }
  }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  try {
    self.postMessage({ id: e.data.id, result: await handle(e.data) })
  } catch (err) {
    self.postMessage({ id: e.data.id, error: (err as Error).message })
  }
}
