<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { RowView } from '../composables/useDump'
import type { SortKey } from '../lib/dump-store'
import { hue, abbreviate } from '../lib/type-hue'

const props = defineProps<{
  total: number
  sharedDigits: number
  sort: SortKey
  descending: boolean
  fetchWindow: (start: number, end: number) => Promise<{ start: number; rows: RowView[] }>
}>()

const emit = defineEmits<{
  (e: 'inspect', row: RowView): void
  (e: 'sort', key: SortKey, descending: boolean): void
}>()

/**
 * Sorting is free here, and that is not obvious given the table streams its
 * rows in windows.
 *
 * The windowing is over an index array the worker already holds — `query`
 * produces a Uint32Array of matching row numbers, sorts it, and the UI asks
 * for slices of it by position. Order is therefore decided before any chunk
 * is handed out, not assembled across chunks, so a re-sort is one comparator
 * pass in the worker (a few hundred ms at ~800k rows, the same cost the
 * existing path sort already pays) followed by the scroll reset that a new
 * query does anyway. Nothing has to be re-fetched or merged.
 */
type ColId = 'addr' | 'type' | 'name' | 'path' | 'off'

const COLUMNS: { id: ColId; key: SortKey; label: string; cls: string }[] = [
  { id: 'addr', key: 'address', label: 'ADDRESS', cls: 'col-addr' },
  { id: 'type', key: 'type', label: 'TYPE', cls: 'col-type' },
  { id: 'name', key: 'name', label: 'NAME', cls: 'col-name' },
  { id: 'path', key: 'path', label: 'CONTAINER', cls: 'col-path' },
  { id: 'off', key: 'offset', label: 'OFF', cls: 'col-off' },
]

/** asc → desc → off. The third click restores dump order, which is a view
 *  people want back and would otherwise have no control for. */
function cycle(key: SortKey) {
  if (props.sort !== key) emit('sort', key, false)
  else if (!props.descending) emit('sort', key, true)
  else emit('sort', 'natural', false)
}

const arrow = (key: SortKey) =>
  props.sort !== key ? '' : props.descending ? '↓' : '↑'

// --------------------------------------------------------------- column size

const DEFAULT_W: Record<ColId, number> = { addr: 128, type: 138, name: 300, path: 420, off: 56 }
const MIN_W = 44
const GAP = 14
const PAD = 12
const WIDTH_KEY = 'pdx:column-widths'

const widths = ref<Record<ColId, number>>({ ...DEFAULT_W })

const vars = computed(() => {
  const w = widths.value
  const sum = COLUMNS.reduce((n, c) => n + w[c.id], 0)
  return {
    '--w-addr': w.addr + 'px',
    '--w-type': w.type + 'px',
    '--w-name': w.name + 'px',
    '--w-path': w.path + 'px',
    '--w-off': w.off + 'px',
    // Header and rows both take this as a *minimum*: narrower than the
    // viewport and CONTAINER absorbs the slack, wider and the table scrolls.
    '--row-w': sum + GAP * (COLUMNS.length - 1) + PAD * 2 + 'px',
  }
})

let drag: { id: ColId; x: number; from: number } | null = null

function gripDown(e: PointerEvent, id: ColId) {
  e.preventDefault()
  const grip = e.currentTarget as HTMLElement
  const rendered = grip.parentElement?.getBoundingClientRect().width
  drag = { id, x: e.clientX, from: Math.round(rendered || widths.value[id]) }
  grip.setPointerCapture(e.pointerId)
}

function gripMove(e: PointerEvent) {
  if (!drag) return
  widths.value = {
    ...widths.value,
    [drag.id]: Math.max(MIN_W, Math.round(drag.from + e.clientX - drag.x)),
  }
}

function gripUp() {
  if (!drag) return
  drag = null
  saveWidths()
}

/** Double-click a grip to put that one column back where it started. */
function resetWidth(id: ColId) {
  widths.value = { ...widths.value, [id]: DEFAULT_W[id] }
  saveWidths()
}

function saveWidths() {
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify(widths.value))
  } catch {
    /* private mode, or the quota is full; widths are not worth failing over */
  }
}

function loadWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTH_KEY) || 'null')
    if (!raw) return
    const next = { ...DEFAULT_W }
    // Read key by key rather than trusting the blob: a stored layout from a
    // build with different columns must not resurrect them.
    for (const c of COLUMNS) {
      if (Number.isFinite(raw[c.id])) next[c.id] = Math.max(MIN_W, raw[c.id])
    }
    widths.value = next
  } catch {
    /* unparseable; the defaults are already in place */
  }
}

const ROW_H = 26
const OVERSCAN = 24

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const height = ref(600)
const buffer = ref<{ start: number; rows: RowView[] }>({ start: 0, rows: [] })
const selected = ref(-1)
let generation = 0

const firstVisible = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const lastVisible = computed(() =>
  Math.min(props.total, Math.ceil((scrollTop.value + height.value) / ROW_H) + OVERSCAN),
)

async function refill() {
  const g = ++generation
  const { start, rows } = await props.fetchWindow(firstVisible.value, lastVisible.value)
  if (g === generation) buffer.value = { start, rows }
}

let queued = false
function onScroll() {
  scrollTop.value = viewport.value?.scrollTop ?? 0
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    refill()
  })
}

function measure() {
  height.value = viewport.value?.clientHeight ?? 600
}

onMounted(() => {
  loadWidths()
  measure()
  measureChar()
  // Web fonts land after mount and change the glyph width under us.
  document.fonts?.ready.then(measureChar).catch(() => {})

  new ResizeObserver(measure).observe(viewport.value!)

  // Measuring the rendered header cell rather than reading `widths` picks up
  // the flex growth too, which on a wide window is most of CONTAINER's width.
  const head = viewport.value?.querySelector('.head .col-path')
  if (head) new ResizeObserver(([e]) => (pathPx.value = e!.contentRect.width)).observe(head)

  refill()
})

watch(
  () => props.total,
  () => {
    if (viewport.value) viewport.value.scrollTop = 0
    scrollTop.value = 0
    selected.value = -1
    refill()
  },
)

const visible = computed(() => {
  const { start, rows } = buffer.value
  const out: { i: number; row: RowView | null }[] = []
  for (let i = firstVisible.value; i < lastVisible.value; i++) {
    out.push({ i, row: rows[i - start] ?? null })
  }
  return out
})

const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, '0')

/**
 * CONTAINER is the one column that cannot use CSS ellipsis.
 *
 * Ellipsis keeps the head of the string and drops the tail, and for a package
 * path the tail is the part that identifies it — `…Engine.Actor:Tick` says
 * something, `/Script/Game/Content/Bluepr…` says nothing. So it is trimmed in
 * JS from the left. (Not with `direction: rtl`, which reorders the slashes
 * and colons — they are bidi-neutral and end up in the wrong place.)
 *
 * The cost of doing it in JS is that the cut has to know the column's width
 * in characters, which is measured rather than assumed: the column is now
 * resizable, and it also flexes to absorb slack on a wide window.
 */
const pathPx = ref(420)
const charPx = ref(7.2)
const containerMax = computed(() => Math.max(8, Math.floor((pathPx.value - 2) / charPx.value)))

function tail(s: string, max: number) {
  return s.length <= max ? s : '…' + s.slice(s.length - max + 1)
}

/** Rows are monospaced, so one glyph measurement describes every string. */
function measureChar() {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono')
  ctx.font = `12px ${mono || 'monospace'}`
  const w = ctx.measureText('0'.repeat(64)).width / 64
  if (w > 0) charPx.value = w
}
</script>

<template>
  <div class="table" :style="vars">
    <div ref="viewport" class="viewport" @scroll.passive="onScroll" tabindex="0">
      <!-- Sticky rather than a sibling of the viewport, so that it scrolls
           sideways with the rows it labels and needs no scroll syncing. -->
      <header class="head mono">
        <div
          v-for="(c, i) in COLUMNS"
          :key="c.key"
          class="hcell"
          :class="c.cls"
        >
          <button
            type="button"
            class="sorter"
            :class="{ on: sort === c.key }"
            :title="
              sort === c.key && descending
                ? 'Sorted descending — click for dump order'
                : sort === c.key
                  ? 'Sorted ascending — click for descending'
                  : `Sort by ${c.label.toLowerCase()}`
            "
            :aria-sort="sort === c.key ? (descending ? 'descending' : 'ascending') : 'none'"
            @click="cycle(c.key)"
          >
            {{ c.label }}<i class="arrow">{{ arrow(c.key) }}</i>
          </button>
          <!-- No grip on the last column: it would hang past the header's
               padding, and OFF is a fixed-width hex field with nothing to
               reveal. Widening the four to its left is the whole need. -->
          <span
            v-if="i < COLUMNS.length - 1"
            class="grip"
            role="separator"
            aria-orientation="vertical"
            :aria-label="`Resize ${c.label.toLowerCase()} column`"
            title="Drag to resize · double-click to reset"
            @pointerdown="gripDown($event, c.id)"
            @pointermove="gripMove"
            @pointerup="gripUp"
            @pointercancel="gripUp"
            @dblclick="resetWidth(c.id)"
          />
        </div>
      </header>

      <div class="spacer" :style="{ height: total * ROW_H + 'px' }">
        <div
          v-for="cell in visible"
          :key="cell.i"
          class="row mono"
          :class="{ sel: selected === cell.i, pending: !cell.row }"
          :style="{ top: cell.i * ROW_H + 'px' }"
          @click="cell.row && ((selected = cell.i), emit('inspect', cell.row))"
        >
          <template v-if="cell.row">
            <span class="col-addr">
              <i class="ghost">{{ hex(cell.row.address).slice(0, sharedDigits) }}</i
              >{{ hex(cell.row.address).slice(sharedDigits) }}
            </span>
            <span
              class="col-type"
              :style="{ color: hue(cell.row.type) }"
              :title="cell.row.type"
            >
              <i class="tick" :style="{ background: hue(cell.row.type) }" />
              {{ abbreviate(cell.row.type) }}
            </span>
            <span class="col-name" :title="cell.row.name">{{ cell.row.name }}</span>
            <span class="col-path" :title="cell.row.path">{{
              tail(cell.row.container, containerMax)
            }}</span>
            <span class="col-off">{{
              cell.row.offset < 0 ? '' : '0x' + cell.row.offset.toString(16).toUpperCase()
            }}</span>
          </template>
        </div>
      </div>

      <p v-if="total === 0" class="empty">
        No objects match. Widen the search, or clear the path filter in the spine.
      </p>
    </div>
  </div>
</template>

<style scoped>
.table {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* Sticky inside the scroller: pinned vertically, free to travel sideways with
   the rows. `min-width` is what keeps its background under the far columns
   once the table is scrolled right — width:100% alone would stop at the
   viewport edge. */
.head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 14px;
  padding: 0 12px;
  height: 28px;
  align-items: stretch;
  width: 100%;
  min-width: var(--row-w);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--dim);
  background: var(--panel);
  border-bottom: 1px solid var(--rule);
  flex: none;
}

/* Header cells carry the same .col-* geometry as the row spans below them,
   so the two stay aligned by construction rather than by arithmetic. */
.head .hcell {
  position: relative;
  display: flex;
  align-items: center;
  color: var(--dim);
  /* The .col-* classes clip their content so row text ellipsises, but the
     grip hangs 13px into the gutter *past* this cell's edge — inheriting that
     clip erases it. Labels still clip: .sorter hides its own overflow. */
  overflow: visible;
}
.head .sorter {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.head .sorter:hover {
  color: var(--ink);
}
.head .sorter.on {
  color: var(--amber);
}
.head .col-off .sorter {
  justify-content: flex-end;
}
.arrow {
  font-style: normal;
  font-size: 9px;
}

/* Sits in the 14px gutter between columns, straddling the boundary it moves.
   Wider than it looks: 13px of target for a 1px line. */
.grip {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -13px;
  width: 13px;
  cursor: col-resize;
  touch-action: none;
  z-index: 1;
}
.grip::after {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 6px;
  width: 1px;
  background: var(--rule);
  transition: background 0.12s;
}
.grip:hover::after,
.grip:active::after {
  top: 0;
  bottom: 0;
  background: var(--amber);
}

.viewport {
  flex: 1;
  overflow: auto;
  position: relative;
  min-height: 0;
}

.spacer {
  position: relative;
  width: 100%;
  min-width: var(--row-w);
}

.row {
  position: absolute;
  left: 0;
  right: 0;
  height: 26px;
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  white-space: nowrap;
  border-bottom: 1px solid var(--rule-soft);
  cursor: default;
}

.row:hover {
  background: var(--panel);
}
.row.sel {
  background: var(--raise);
  box-shadow: inset 2px 0 0 var(--amber);
}
.row.pending {
  opacity: 0.25;
}

/* Every width comes from the custom properties the script maintains, so a
   drag moves the header cell and all ~60 live rows in one recalculation. */

/* Signature: shared address digits recede, the differing tail stays lit. */
.col-addr {
  width: var(--w-addr);
  flex: none;
  color: var(--amber);
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ghost {
  color: var(--dimmer);
  font-style: normal;
}

.col-type {
  width: var(--w-type);
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tick {
  display: inline-block;
  width: 3px;
  height: 10px;
  vertical-align: -1px;
  margin-right: 5px;
  border-radius: 1px;
}

.col-name {
  width: var(--w-name);
  flex: none;
  color: var(--ink-strong);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The one column that grows: on a window wider than the columns need, the
   slack goes to the longest strings in the table rather than to dead space. */
.col-path {
  flex: 1 0 var(--w-path);
  width: var(--w-path);
  min-width: var(--w-path);
  color: var(--dim);
  overflow: hidden;
}

.col-off {
  width: var(--w-off);
  flex: none;
  text-align: right;
  color: var(--dim);
  overflow: hidden;
}

/* Offset by the header's height, which now lives inside this scroller. */
.empty {
  position: absolute;
  inset: 28px 0 0;
  display: grid;
  place-content: center;
  color: var(--dim);
  font-size: 12px;
  max-width: 28ch;
  margin: auto;
  text-align: center;
  line-height: 1.6;
}

/* No narrow-screen column hiding any more: the table scrolls sideways, so a
   phone gets the same columns and reaches them by dragging rather than being
   told CONTAINER does not exist. */
</style>
