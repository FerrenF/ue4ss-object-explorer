/**
 * Dumps the site ships with.
 *
 * These are never fetched on load. A prebaked dump is tens of megabytes, and
 * most visitors arrive with their own file or with one already in IndexedDB;
 * spending their bandwidth on a speculative download would be rude. The
 * manifest is a few hundred bytes and is all we read until someone asks for
 * a dump by name.
 */

export interface HostedDump {
  /** Stable id, independent of the file name. Recorded on the cached copy so
   *  a downloaded dump can be struck from the offer list. */
  id: string
  /** Path under the site root. */
  file: string
  title: string
  note?: string
  /** Bytes on the wire, for the "how big is this" question. Optional. */
  bytes?: number
  /** 'pdx' is a prebaked column bundle; 'text' is a raw UE4SS dump. */
  format?: 'text' | 'pdx'
}

const MANIFEST = '/dumps.json'

export async function listHosted(): Promise<HostedDump[]> {
  const res = await fetch(MANIFEST, { cache: 'no-cache' })
  if (!res.ok) return []
  const body = await res.json()
  return Array.isArray(body) ? body : (body.dumps ?? [])
}

/**
 * Fetch with byte progress. `Content-Length` is absent under chunked transfer
 * encoding, which nginx will use for these once gzip is on, so the caller has
 * to tolerate a null fraction rather than a bogus one.
 */
export async function download(
  d: HostedDump,
  onProgress?: (fraction: number | null, received: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(d.file)
  if (!res.ok) throw new Error(`Could not fetch ${d.file} (${res.status})`)

  const declared = Number(res.headers.get('content-length')) || d.bytes || 0
  if (!res.body) return res.arrayBuffer()

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(declared ? Math.min(1, received / declared) : null, received)
  }

  const out = new Uint8Array(received)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out.buffer
}

/** File name to record on the cached copy, so titles read like a real file. */
export const fileNameOf = (d: HostedDump) => d.file.split('/').pop() || d.id
