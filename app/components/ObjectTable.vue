<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { RowView } from '../composables/useDump'
import { hue, abbreviate } from '../lib/type-hue'

const props = defineProps<{
  total: number
  sharedDigits: number
  fetchWindow: (start: number, end: number) => Promise<{ start: number; rows: RowView[] }>
}>()

const emit = defineEmits<{ (e: 'inspect', row: RowView): void }>()

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
  measure()
  new ResizeObserver(measure).observe(viewport.value!)
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
 * Show the tail of a long path, which is the part that identifies it.
 * Done in JS rather than with `direction: rtl`, because these strings are
 * full of slashes and colons — neutral characters that bidi reordering
 * happily moves to the wrong end.
 */
function tail(s: string, max = 64) {
  return s.length <= max ? s : '…' + s.slice(s.length - max + 1)
}
</script>

<template>
  <div class="table">
    <header class="head mono">
      <span class="col-addr">ADDRESS</span>
      <span class="col-type">TYPE</span>
      <span class="col-name">NAME</span>
      <span class="col-path">CONTAINER</span>
      <span class="col-off">OFF</span>
    </header>

    <div ref="viewport" class="viewport" @scroll.passive="onScroll" tabindex="0">
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
            <span class="col-name">{{ cell.row.name }}</span>
            <span class="col-path" :title="cell.row.path">{{ tail(cell.row.container) }}</span>
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

.head {
  display: flex;
  gap: 14px;
  padding: 0 12px;
  height: 28px;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--dim);
  background: var(--panel);
  border-bottom: 1px solid var(--rule);
  flex: none;
}

.viewport {
  flex: 1;
  overflow: auto;
  position: relative;
  min-height: 0;
}

.spacer {
  position: relative;
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

/* Signature: shared address digits recede, the differing tail stays lit. */
.col-addr {
  width: var(--gutter-w);
  flex: none;
  color: var(--amber);
  letter-spacing: 0.03em;
}
.ghost {
  color: var(--dimmer);
  font-style: normal;
}

.col-type {
  width: 138px;
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
  width: 300px;
  flex: none;
  color: var(--ink-strong);
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-path {
  flex: 1;
  min-width: 0;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-off {
  width: 56px;
  flex: none;
  text-align: right;
  color: var(--dim);
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  color: var(--dim);
  font-size: 12px;
  max-width: 28ch;
  margin: auto;
  text-align: center;
  line-height: 1.6;
}

@media (max-width: 900px) {
  .col-name {
    width: 180px;
  }
  .col-off,
  .col-path {
    display: none;
  }
}
</style>
