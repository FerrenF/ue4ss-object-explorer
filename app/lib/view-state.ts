import type { SortKey } from './dump-store'

/**
 * Everything about "what am I looking at" that is worth putting in a link.
 *
 * Types are carried as names rather than as the numeric ids the store uses.
 * Ids are assigned in first-seen order, so they are stable for a given dump —
 * but only for that dump, and a link that silently means something else
 * against a different dump is worse than one that drops a filter it cannot
 * resolve.
 */
export interface ViewState {
  prefix: string
  name: string
  path: string
  sort: SortKey
  desc: boolean
  types: string[]
}

export const emptyView = (): ViewState => ({
  prefix: '',
  name: '',
  path: '',
  sort: 'natural',
  desc: false,
  types: [],
})

const SORTS: SortKey[] = ['natural', 'path', 'address', 'offset', 'name', 'type']

export function sameView(a: ViewState, b: ViewState): boolean {
  return (
    a.prefix === b.prefix &&
    a.name === b.name &&
    a.path === b.path &&
    a.sort === b.sort &&
    a.desc === b.desc &&
    a.types.length === b.types.length &&
    a.types.every((t, i) => t === b.types[i])
  )
}

/**
 * Only non-default fields are written, so the common case — a dump open with
 * no filters — is a URL you can read aloud.
 */
export function encodeView(dump: string, v: ViewState): string {
  const q = new URLSearchParams()
  if (dump) q.set('d', dump)
  if (v.prefix) q.set('p', v.prefix)
  if (v.name) q.set('n', v.name)
  if (v.path) q.set('q', v.path)
  if (v.sort !== 'natural') q.set('s', v.sort)
  if (v.desc) q.set('o', 'desc')
  if (v.types.length) q.set('t', v.types.join(','))
  const s = q.toString()
  return s ? '?' + s : location.pathname
}

export function decodeView(search: string): { dump: string; view: ViewState } {
  const q = new URLSearchParams(search)
  const sort = q.get('s') as SortKey | null
  return {
    dump: q.get('d') ?? '',
    view: {
      prefix: q.get('p') ?? '',
      name: q.get('n') ?? '',
      path: q.get('q') ?? '',
      sort: sort && SORTS.includes(sort) ? sort : 'natural',
      desc: q.get('o') === 'desc',
      // Sorted on the way in as well as out: `sameView` compares positionally,
      // and a hand-edited URL should not read as a different view.
      types: (q.get('t') ?? '').split(',').filter(Boolean).sort(),
    },
  }
}
