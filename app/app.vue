<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useDump, type RowView, type Members } from './composables/useDump'
import { useFrames } from './composables/useFrames'
import { hue, abbreviate } from './lib/type-hue'
import { listDumps, dropDump, type CachedDump } from './lib/persist'
import { listHosted, download, fileNameOf, type HostedDump } from './lib/hosted'
import { encodeView, decodeView, emptyView, type ViewState } from './lib/view-state'
import type { SortKey } from './lib/dump-store'
import HeaderBar from './components/HeaderBar.vue'
const d = useDump()
const frames = useFrames()

const nameQuery = ref('')
const pathQuery = ref('')
const pathPrefix = ref('')
const activeTypes = ref<number[]>([])
const sort = ref<SortKey>('natural')
const descending = ref(false)
const inspected = ref<RowView | null>(null)
const outerOf = ref<RowView | null>(null)
const members = ref<Members | null>(null)
const cached = ref<CachedDump[]>([])
const hosted = ref<HostedDump[]>([])
const showAllTypes = ref(false)
const dragging = ref(false)
const treeVersion = ref(0)

// pending view
const pending = ref<{ hash: string; view: ViewState } | null>(null)

const fmt = new Intl.NumberFormat()

// --- view

function currentView(): ViewState {
  return {
    prefix: pathPrefix.value,
    name: nameQuery.value.trim(),
    path: pathQuery.value.trim(),
    sort: sort.value,
    desc: descending.value,
    types: activeTypes.value
      .map((id) => d.types.value[id])
      .filter((n): n is string => !!n)
      .sort(),
  }
}

function applyView(v: ViewState) {
  pathPrefix.value = v.prefix
  nameQuery.value = v.name
  pathQuery.value = v.path
  sort.value = v.sort
  descending.value = v.desc
  activeTypes.value = v.types.map((n) => d.types.value.indexOf(n)).filter((i) => i >= 0)
}

function syncUrl(v: ViewState) {
  history.replaceState(null, '', encodeView(d.dumpKey.value, v))
}

let timer: ReturnType<typeof setTimeout>
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(commit, 120)
}

function commit() {
  const v = currentView()
  frames.push(v)
  syncUrl(v)
  run()
}

async function run() {
  if (!d.ready.value) return
  await d.runQuery({
    typeIds: activeTypes.value,
    pathPrefix: pathPrefix.value || undefined,
    nameContains: nameQuery.value.trim() || undefined,
    pathContains: pathQuery.value.trim() || undefined,
    sort: sort.value,
    descending: descending.value,
  })
}

watch([nameQuery, pathQuery], schedule)
watch([pathPrefix, activeTypes, sort, descending], commit, { deep: true })

/** A new dump invalidates every frame: the paths and types are a different vocabulary, so the queue restarts rather than carrying over. */
function resetTo(v: ViewState) {
  applyView(v)
  inspected.value = null
  outerOf.value = null
  members.value = null
  showAllTypes.value = false
  treeVersion.value++
  frames.reset(currentView())
  syncUrl(frames.current.value)
  run()
}

watch(d.count, () => {
  const p = pending.value
  const claimed = !!p && p.hash === d.dumpKey.value
  resetTo(claimed ? p!.view : emptyView())
  if (claimed) {
    pending.value = null
    linkMiss.value = false
  }
  refreshCached()
})

function setSort(key: SortKey, desc: boolean) {
  sort.value = key
  descending.value = desc
}

function clearHistory() {
  frames.clear()
  syncUrl(currentView())
}

function step(delta: -1 | 1) {
  const f = delta < 0 ? frames.back() : frames.forward()
  if (!f) return
  applyView(f)
  syncUrl(f)
  run()
}

const copied = ref(false)
async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    /* clipboard blocked; the URL bar already shows the link */
  }
}

function toggleType(id: number) {
  const i = activeTypes.value.indexOf(id)
  i === -1 ? activeTypes.value.push(id) : activeTypes.value.splice(i, 1)
}

/** Types the current filter can actually reach, busiest first. */
const typeChips = computed(() => {
  const counts = d.typeCounts.value
  return d.types.value
    .map((name, id) => ({ id, name, count: counts[id] ?? 0 }))
    .filter((t) => t.count > 0 || activeTypes.value.includes(t.id))
    .sort((a, b) => b.count - a.count)
})
const shownChips = computed(() =>
  showAllTypes.value ? typeChips.value : typeChips.value.slice(0, 14),
)

let inspectSeq = 0
async function inspect(row: RowView) {
  const seq = ++inspectSeq
  inspected.value = row
  outerOf.value = null
  const [owner, m] = await Promise.all([
    row.outer ? d.resolveAddress(row.outer).then((r) => r.row) : null,
    d.fetchMembers(row.index),
  ])
  // A quicker click elsewhere wins; a slow answer must not overwrite it.
  if (seq !== inspectSeq) return
  outerOf.value = owner
  members.value = m
}

function closeInspector() {
  inspected.value = null
  members.value = null
}

/**
 * The inspector's member list, split the way a reader uses it: for a function,
 * what you pass, what you get back, and the Blueprint temporaries last; for a
 * class or struct, its properties and then its functions.
 */
const memberSections = computed(() => {
  const m = members.value
  if (!m?.head) return []
  const all = m.members
  if (m.head.role === 'function') {
    return [
      { label: 'Params', rows: all.filter((r) => r.role === 'param'), dim: false },
      { label: 'Returns', rows: all.filter((r) => r.role === 'return'), dim: false },
      { label: 'Locals', rows: all.filter((r) => r.role === 'local'), dim: true },
    ].filter((s) => s.rows.length)
  }
  return [
    { label: 'Properties', rows: all.filter((r) => r.role !== 'function'), dim: false },
    { label: 'Functions', rows: all.filter((r) => r.role === 'function'), dim: false },
  ].filter((s) => s.rows.length)
})

function jumpTo(path: string) {
  pathPrefix.value = path
  nameQuery.value = ''
  pathQuery.value = ''
}

// -------------------------------------------------------------- subtree dump

const report = ref({ open: false, root: '', text: '', objects: 0, truncated: false, error: '' })
const reportLoading = ref(false)

/** Walk everything at or under `path` and render it as a reference sheet. */
async function dumpSubtree(path: string) {
  report.value = { open: true, root: path, text: '', objects: 0, truncated: false, error: '' }
  reportLoading.value = true
  try {
    const r = await d.buildReport(path)
    report.value = { ...report.value, ...r }
  } catch (e) {
    report.value = { ...report.value, error: (e as Error).message }
  } finally {
    reportLoading.value = false
  }
}

async function onDrop(e: DragEvent) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) await d.loadFile(file)
}

function onPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) d.loadFile(file)
}

async function refreshCached() {
  cached.value = await listDumps().catch(() => [])
}

async function forget(key: string) {
  await dropDump(key)
  refreshCached()
}

// --- site dumps

const grabbing = ref('')
const grabPct = ref<number | null>(0)
const grabError = ref('')

/** Only dumps this browser has not already taken. */
const offered = computed(() => {
  const have = new Set(cached.value.map((c) => c.source).filter(Boolean))
  return hosted.value.filter((h) => !have.has(h.id))
})

/**
 * Download on demand, never on load.
 */

async function grab(h: HostedDump) {
  grabbing.value = h.id
  grabError.value = ''
  grabPct.value = 0
  try {
    const buffer = await download(h, (f) => (grabPct.value = f))
    await d.loadBuffer(buffer, fileNameOf(h), { format: h.format ?? 'text', source: h.id })
    await refreshCached()
  } catch (e) {
    grabError.value = (e as Error).message
  } finally {
    grabbing.value = ''
    grabPct.value = 0
  }
}


async function clearDump() {
  await d.reset()
  dragging.value = false
}



// 'cache miss' client did not have downloaded dump
const linkMiss = ref(false)

onMounted(async () => {
  await refreshCached()
  listHosted()
    .then((h) => (hosted.value = h))
    .catch(() => {})

  const { dump, view } = decodeView(location.search)
  if (!dump) return
  pending.value = { hash: dump, view }
  if (!(await d.restore(dump))) {
    linkMiss.value = true
    // a link arriving without its dump is the expected case
    d.error.value = ''
  }
})

const tail = (s: string, max = 72) =>
  s.length <= max ? s : '…' + s.slice(s.length - max + 1)
const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(12, '0')
const mb = (n: number) => (n / 1e6).toFixed(1) + ' MB'
</script>

<template>
  <div class="app" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    
    <!-- header -->
    <header>
    <HeaderBar :onPick="onPick" :onClear="clearDump" :shows-clear="d.ready.value">      
      <div v-if="d.ready.value" class="readout mono">
        <span class="file">{{ d.label.value }}</span>
        <span class="sep">·</span>
        <span>{{ fmt.format(d.count.value) }} objects</span>
        <span class="sep">·</span>
        <span>{{ d.types.value.length }} types</span>
        <span v-if="d.skipped.value" class="sep">·</span>
        <span v-if="d.skipped.value" class="warn">{{ d.skipped.value }} unparsed lines</span>
      </div>
      
    </HeaderBar>

  </header>

    <!-- first run -->
    <section v-if="!d.ready.value" class="intro">
      <div class="intro-card">
        <p class="eyebrow">Start Here</p>
        <h1>Drop a UE4SS object dump.</h1>
        <NuxtLink href="https://github.com/UE4SS-RE/RE-UE4SS/blob/main/docs/feature-overview/dumpers.md" target="_blank">See documentation about dumpers here.</NuxtLink>
        <p class="lede">
          Drag and drop a UE4SS object dump below. This tool is not meant for unreal header dumps, but the actual object dump. It's generally a single large text file.
        </p>     
         <p class="lede">
         Dumps are saved locally. While this tool was created for Palworld, it will probably work for most other UE4SS supported games.
        </p>     
        <label class="drop" :class="{ hot: dragging }">
          <input type="file" accept=".txt,.log,.dump" hidden @change="onPick" />
          <span v-if="!d.loading.value" class="mono">Drop UE4SS_ObjectDump.txt here</span>
          <span v-else class="mono">Parsing… {{ Math.round(d.progress.value * 100) }}%</span>
          <div v-if="d.loading.value" class="meter">
            <i :style="{ width: d.progress.value * 100 + '%' }" />
          </div>
        </label>

        <p v-if="d.error.value" class="err mono">{{ d.error.value }}</p>
        <p v-if="linkMiss" class="err mono">
          That link points at a dump this browser has not loaded yet. Open the same
          file below or drop it above, and the link will work from then on.
        </p>

        <div v-if="offered.length" class="cached">
          <p class="eyebrow">Available from this site</p>
          <div v-for="h in offered" :key="h.id" class="cache-row mono">
            <span class="cache-name">{{ h.title }}</span>
            <span class="cache-meta">
              <template v-if="h.bytes">{{ mb(h.bytes) }}</template>
              <template v-if="h.note"> · {{ h.note }}</template>
            </span>
            <button
              class="get"
              :disabled="!!grabbing"
              @click="grab(h)"
            >
              <template v-if="grabbing !== h.id">download</template>
              <template v-else-if="grabPct === null">downloading…</template>
              <template v-else>{{ Math.round(grabPct * 100) }}%</template>
            </button>
          </div>
          <div v-if="grabbing" class="meter thin">
            <i :style="{ width: (grabPct ?? 0) * 100 + '%' }" />
          </div>
          <p v-if="grabError" class="err mono">{{ grabError }}</p>
        </div>

        <div v-if="cached.length" class="cached">
          <p class="eyebrow">Already parsed</p>
          <button v-for="c in cached" :key="c.key" class="cache-row mono" @click="d.restore(c.key)">
            <span class="cache-name">{{ c.label }}</span>
            <span class="cache-meta">{{ fmt.format(c.cols.count) }} objects · {{ mb(c.bytes) }}</span>
            <span class="cache-drop" @click.stop="forget(c.key)">forget</span>
          </button>
        </div>
      </div>
    </section>

    <!-- explorer -->
    <main v-else class="body">
      <PathTree
        v-model="pathPrefix"
        :fetch-children="d.fetchChildren"
        :version="treeVersion"
        @dump="dumpSubtree"
      />

      <section class="main">
        <div class="controls">
          <div class="searches">
            <!-- Filter history. Every change to the query surface lands here as
                 a frame, so stepping back is stepping back through views. -->
            <div class="frames mono">
              <button
                class="wipe"
                :disabled="frames.frames.value.length < 2"
                title="Clear filter history"
                aria-label="Clear filter history"
                @click="clearHistory"
              >
                ×
              </button>
              <button
                :disabled="!frames.canBack.value"
                title="Previous view"
                aria-label="Previous view"
                @click="step(-1)"
              >
                ‹
              </button>
              <span class="tally" :title="`Frame ${frames.index.value + 1} of ${frames.frames.value.length}`">
                {{ frames.index.value + 1 }}/{{ frames.frames.value.length }}
              </span>
              <button
                :disabled="!frames.canForward.value"
                title="Next view"
                aria-label="Next view"
                @click="step(1)"
              >
                ›
              </button>
            </div>

            <input v-model="nameQuery" placeholder="search name…" spellcheck="false" />
            <input v-model="pathQuery" placeholder="search full path…" spellcheck="false" />

            <button class="share mono" title="Copy a link to this exact view" @click="copyLink">
              {{ copied ? 'copied' : 'link' }}
            </button>
          </div>

          <div v-if="pathPrefix" class="crumb mono">
            <span class="eyebrow">under</span>
            <span class="crumb-path" :title="pathPrefix">{{ tail(pathPrefix) }}</span>
            <button @click="pathPrefix = ''">×</button>
          </div>

          <div class="chips">
            <button
              v-for="t in shownChips"
              :key="t.id"
              class="chip mono"
              :class="{ on: activeTypes.includes(t.id) }"
              :style="{ '--chip': hue(t.name) }"
              :title="t.name"
              @click="toggleType(t.id)"
            >
              <i class="tick" />{{ abbreviate(t.name) }}
              <b>{{ fmt.format(t.count) }}</b>
            </button>
            <button
              v-if="typeChips.length > 14"
              class="chip more"
              @click="showAllTypes = !showAllTypes"
            >
              {{ showAllTypes ? 'fewer' : `+${typeChips.length - 14} more` }}
            </button>
          </div>
        </div>

        <ObjectTable
          :total="d.total.value"
          :revision="d.revision.value"
          :shared-digits="d.sharedAddressDigits.value"
          :sort="sort"
          :descending="descending"
          :selected-index="inspected?.index ?? -1"
          :selected-group="inspected?.group ?? -1"
          :fetch-window="d.fetchWindow"
          @inspect="inspect"
          @sort="setSort"
          @scope="jumpTo"
        />

        <footer class="status mono">
          <span>{{ fmt.format(d.matches.value) }} / {{ fmt.format(d.count.value) }} shown</span>
          <template v-if="d.total.value > d.matches.value">
            <span class="sep">·</span>
            <span :title="'Owners listed so each match appears under its parent'">
              +{{ fmt.format(d.total.value - d.matches.value) }} owners
            </span>
          </template>
          <span class="sep">·</span>
          <span>{{ d.queryMs.value.toFixed(0) }} ms</span>
          <span v-if="d.parseMs.value" class="sep">·</span>
          <span v-if="d.parseMs.value">parsed in {{ (d.parseMs.value / 1000).toFixed(1) }} s</span>
        </footer>
      </section>

      <!-- inspector -->
      <aside v-if="inspected" class="inspect">
        <div class="inspect-head">
          <span class="eyebrow">Object</span>
          <button @click="closeInspector">×</button>
        </div>
        <dl class="mono">
          <dt>type</dt>
          <dd :style="{ color: hue(inspected.type) }">{{ inspected.type }}</dd>
          <dt>name</dt>
          <dd class="strong">{{ inspected.name }}</dd>
          <dt>address</dt>
          <dd class="addr">{{ hex(inspected.address) }}</dd>
          <dt v-if="inspected.offset >= 0">offset</dt>
          <dd v-if="inspected.offset >= 0">
            0x{{ inspected.offset.toString(16).toUpperCase() }}
            <i class="dec">({{ inspected.offset }})</i>
          </dd>
          <dt>path</dt>
          <dd class="wrap">{{ inspected.path }}</dd>
          <dt v-if="outerOf">owner</dt>
          <dd v-if="outerOf" class="wrap">
            <button class="link" @click="jumpTo(outerOf.path)">{{ outerOf.path }}</button>
          </dd>
        </dl>

        <!-- Signature for a function (or the function a parameter belongs
             to); member list for a class or struct. -->
        <section v-if="members?.head" class="members mono">
          <div class="members-head">
            <span class="eyebrow">{{ members.head.role === 'function' ? 'Signature' : 'Members' }}</span>
            <button
              v-if="members.head.index !== inspected.index"
              class="link"
              :title="members.head.path"
              @click="inspect(members.head)"
            >
              {{ members.head.name }}
            </button>
          </div>
          <p v-if="!memberSections.length" class="members-none">none</p>
          <div v-for="s in memberSections" :key="s.label" class="members-group" :class="{ dim: s.dim }">
            <p class="members-label">{{ s.label }} <b>{{ s.rows.length }}</b></p>
            <button
              v-for="m in s.rows"
              :key="m.index"
              class="member"
              :class="{ on: m.index === inspected.index }"
              :title="m.path"
              @click="inspect(m)"
            >
              <span class="m-off">{{ m.offset < 0 ? '' : '+' + m.offset.toString(16).toUpperCase() }}</span>
              <span class="m-name">{{ m.name }}</span>
              <span class="m-type" :style="{ color: hue(m.type) }">{{ abbreviate(m.type) }}</span>
            </button>
          </div>
          <p v-if="members.total > members.members.length" class="members-none">
            +{{ fmt.format(members.total - members.members.length) }} more not listed
          </p>
        </section>

        <button class="scope" @click="jumpTo(inspected.path)">Scope tree to this object</button>
        <button class="scope" @click="dumpSubtree(inspected.path)">Dump tree under this object</button>
      </aside>
    </main>

    <ReportModal
      :open="report.open"
      :root="report.root"
      :text="report.text"
      :objects="report.objects"
      :truncated="report.truncated"
      :error="report.error"
      :loading="reportLoading"
      @close="report.open = false"
    />

    <div v-if="dragging && d.ready.value" class="veil mono">Release to parse a new dump</div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* first run */
.intro {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: auto;
}
.intro-card {
  width: min(560px, 100%);
}
.intro h1 {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 10px 0 12px;
  color: var(--ink-strong);
}
.lede {
  color: var(--dim);
  line-height: 1.65;
  margin: 10px 0 22px;
  max-width: 52ch;
}

.drop {
  display: grid;
  place-items: center;
  gap: 12px;
  height: 130px;
  border: 1px dashed var(--rule);
  border-radius: 4px;
  color: var(--dim);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.drop:hover,
.drop.hot {
  border-color: var(--amber);
  color: var(--amber);
}

.meter {
  width: 260px;
  height: 2px;
  background: var(--rule);
}
.meter i {
  display: block;
  height: 100%;
  background: var(--amber);
  transition: width 0.1s linear;
}

.err {
  color: var(--t-bool);
  font-size: 12px;
  margin-top: 14px;
}

.cached {
  margin-top: 28px;
}
.cache-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
  font-size: 12px;
  text-align: left;
}
.cache-row:hover .cache-name {
  color: var(--amber);
}
.cache-name {
  color: var(--ink-strong);
}
.cache-meta {
  color: var(--dimmer);
  font-size: 11px;
  margin-left: auto;
}
.cache-drop {
  color: var(--dimmer);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.cache-drop:hover {
  color: var(--t-bool);
}

.get {
  flex: none;
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
  background: none;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 4px 9px;
  cursor: pointer;
}
.get:hover:not(:disabled) {
  border-color: var(--amber);
}
.get:disabled {
  color: var(--dimmer);
  cursor: default;
}

.meter.thin {
  width: 100%;
  margin-top: 8px;
}

/* explorer */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.controls {
  flex: none;
  padding: 10px 12px;
  border-bottom: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.searches {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.searches input {
  flex: 1;
  min-width: 0;
}

.frames {
  display: flex;
  align-items: center;
  flex: none;
  border: 1px solid var(--rule);
  border-radius: 3px;
  overflow: hidden;
}
.frames button {
  width: 22px;
  align-self: stretch;
  font-size: 15px;
  line-height: 1;
  color: var(--amber);
  background: none;
  border: none;
  cursor: pointer;
}
.frames button:disabled {
  color: var(--dimmer);
  cursor: default;
}
.frames button:not(:disabled):hover {
  background: var(--raise);
}

/* Destructive, so it reads as an aside to the two arrows rather than a third
   navigation control. */
.frames .wipe {
  color: var(--dim);
  font-size: 13px;
  border-right: 1px solid var(--rule);
}
.frames .wipe:not(:disabled):hover {
  color: var(--t-bool);
}
.tally {
  font-size: 10px;
  color: var(--dim);
  padding: 0 6px;
  border-left: 1px solid var(--rule);
  border-right: 1px solid var(--rule);
  align-self: stretch;
  display: flex;
  align-items: center;
}

.share {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dim);
  background: none;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 0 10px;
  cursor: pointer;
}
.share:hover {
  color: var(--amber);
  border-color: var(--amber);
}

.crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--amber);
}
.crumb-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb button {
  color: var(--dim);
  flex: none;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 2px;
  border: 1px solid var(--rule);
  color: var(--dim);
}
.chip .tick {
  width: 3px;
  height: 9px;
  border-radius: 1px;
  background: var(--chip);
}
.chip b {
  font-weight: 400;
  color: var(--dimmer);
}
.chip:hover {
  border-color: var(--chip);
  color: var(--ink);
}
.chip.on {
  border-color: var(--chip);
  color: var(--ink-strong);
  background: color-mix(in srgb, var(--chip) 12%, transparent);
}
.chip.more {
  color: var(--dim);
  border-style: dashed;
}

.status {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  font-size: 11px;
  color: var(--dim);
  background: var(--panel);
  border-top: 1px solid var(--rule);
}

/* inspector */
.inspect {
  width: 320px;
  flex: none;
  background: var(--panel);
  border-left: 1px solid var(--rule);
  padding: 0 0 14px;
  overflow: auto;
}
.inspect-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--rule);
}
.inspect-head button {
  color: var(--dim);
}

.inspect dl {
  margin: 0;
  padding: 12px;
  font-size: 12px;
}
.inspect dt {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-top: 12px;
}
.inspect dt:first-child {
  margin-top: 0;
}
.inspect dd {
  margin: 3px 0 0;
  color: var(--ink);
}
.inspect dd.strong {
  color: var(--ink-strong);
}
.inspect dd.addr {
  color: var(--amber);
}
.inspect dd.wrap {
  word-break: break-all;
  line-height: 1.5;
}
.dec {
  color: var(--dimmer);
  font-style: normal;
}
.link {
  color: var(--t-container);
  text-align: left;
  word-break: break-all;
  line-height: 1.5;
}
.link:hover {
  text-decoration: underline;
}

.members {
  margin: 0 12px 14px;
  padding-top: 12px;
  border-top: 1px solid var(--rule);
  font-size: 11px;
}
.members-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.members-head .link {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.members-none {
  color: var(--dimmer);
  margin: 6px 0 0;
}
.members-label {
  margin: 10px 0 3px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dimmer);
}
.members-label b {
  font-weight: 400;
  color: var(--dim);
}
.member {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  text-align: left;
  border-radius: 2px;
}
.member:hover {
  background: var(--raise);
}
.member.on {
  background: var(--raise);
  box-shadow: inset 2px 0 0 var(--amber);
}
.m-off {
  flex: none;
  width: 4ch;
  text-align: right;
  color: var(--dim);
}
.m-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-strong);
}
.m-type {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.members-group.dim .m-name,
.members-group.dim .m-type {
  color: var(--dim) !important;
}

.scope + .scope {
  margin-top: 6px;
}

.scope {
  margin: 4px 12px 0;
  width: calc(100% - 24px);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--amber);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 7px;
}
.scope:hover {
  border-color: var(--amber);
}

.veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--void) 82%, transparent);
  color: var(--amber);
  font-size: 13px;
  border: 1px dashed var(--amber);
  pointer-events: none;
}

@media (max-width: 900px) {
  .body {
    flex-direction: column;
  }
  .inspect {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--rule);
    max-height: 45vh;
  }
  .readout {
    display: none;
  }
}
</style>
