import { ref, shallowRef, computed } from 'vue'
import type { Query } from '../lib/dump-store'
import type { TreeChild } from '../lib/dump-store'

export interface RowView {
  index: number
  address: number
  type: string
  typeId: number
  path: string
  name: string
  container: string
  outer: number
  offset: number
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

const loading = ref(false)
const progress = ref(0)
const error = ref('')
const label = ref('')
const dumpKey = ref('')
const count = ref(0)
const skipped = ref(0)
const types = shallowRef<string[]>([])
const typeCounts = shallowRef<Int32Array>(new Int32Array(0))
const sharedAddressDigits = ref(0)
const total = ref(0)
const queryMs = ref(0)
const parseMs = ref(0)

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../workers/dump.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, result, error: err, event, fraction } = e.data
    if (event === 'progress') {
      progress.value = fraction
      return
    }
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    err ? p.reject(new Error(err)) : p.resolve(result)
  }
  return worker
}

function call<T = any>(op: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
  const w = ensureWorker()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, op, ...payload }, transfer)
  })
}

export function useDump() {
  /**
   * @param buffer is transferred, not copied: a 60 MB structured clone is a
   * visible stall. The caller must not touch it afterwards.
   */
  async function loadBuffer(
    buffer: ArrayBuffer,
    name: string,
    opts: { format?: 'text' | 'pdx'; source?: string } = {},
  ): Promise<boolean> {
    loading.value = true
    error.value = ''
    progress.value = 0
    try {
      applyMeta(await call('parse', { buffer, name, ...opts }, [buffer]))
      return true
    } catch (e) {
      error.value = (e as Error).message
      return false
    } finally {
      loading.value = false
      progress.value = 0
    }
  }

  const loadFile = async (file: File) => loadBuffer(await file.arrayBuffer(), file.name)

  /** Resolves false when the key is not in the cache, which the URL restore
   *  path treats as "link received without the dump" rather than an error. */
  async function restore(key: string): Promise<boolean> {
    loading.value = true
    error.value = ''
    try {
      applyMeta(await call('restore', { key }))
      return true
    } catch (e) {
      error.value = (e as Error).message
      return false
    } finally {
      loading.value = false
    }
  }

  /** Unload the current dump without deleting it from the cache. */
  async function reset() {
    await call('close').catch(() => {})
    loading.value = false
    error.value = ''
    progress.value = 0
    label.value = ''
    dumpKey.value = ''
    types.value = []
    typeCounts.value = new Int32Array(0)
    skipped.value = 0
    sharedAddressDigits.value = 0
    total.value = 0
    queryMs.value = 0
    parseMs.value = 0
    // Last: `ready` and the app's reset watcher both hang off this.
    count.value = 0
  }

  function applyMeta(r: any) {
    count.value = r.count
    types.value = r.types
    skipped.value = r.skipped
    sharedAddressDigits.value = r.sharedAddressDigits
    label.value = r.label
    dumpKey.value = r.key
    parseMs.value = r.parseMs ?? 0
  }

  async function runQuery(q: Query) {
    const plain: Query = {
      ...q,
      typeIds: q.typeIds ? Array.from(q.typeIds) : undefined,
    }
    const r = await call('query', { query: plain })
    total.value = r.total
    typeCounts.value = r.typeCounts
    queryMs.value = r.ms
    return r
  }

  const fetchWindow = (start: number, end: number) =>
    call<{ start: number; rows: RowView[] }>('window', { start, end })

  const fetchChildren = (prefix: string) =>
    call<{ prefix: string; children: TreeChild[] }>('children', { prefix })

  const resolveAddress = (address: number) =>
    call<{ row: RowView | null }>('resolve', { address })

  return {
    loadFile,
    loadBuffer,
    restore,
    reset,
    runQuery,
    fetchWindow,
    fetchChildren,
    resolveAddress,
    loading,
    progress,
    error,
    label,
    dumpKey,
    count,
    skipped,
    types,
    typeCounts,
    sharedAddressDigits,
    total,
    queryMs,
    parseMs,
    ready: computed(() => count.value > 0),
  }
}
