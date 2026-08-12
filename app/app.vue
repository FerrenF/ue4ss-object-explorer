<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useDump, type RowView } from './composables/useDump'
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
const cached = ref<CachedDump[]>([])
const hosted = ref<HostedDump[]>([])
const showAllTypes = ref(false)
const dragging = ref(false)
const treeVersion = ref(0)

/**
 * Filters carried in from a link, held until the dump they belong to is up.
 *
 * The hash is kept alongside them so that a recipient who did not have the
 * dump, and then loads the file by hand, still lands on the sender's view —
 * while someone who opens an unrelated dump instead does not inherit filters
 * meant for a different one.
 */
const pending = ref<{ hash: string; view: ViewState } | null>(null)

const fmt = new Intl.NumberFormat()

// ------------------------------------------------------------------ the view

/**
 * Type filters travel as names, not as the ids the store indexes by, so both
 * directions have to go through the dump's type table. A name the current
 * dump does not have simply drops out — a link from a newer dump should lose
 * the filter it cannot express, not fail to open.
 */
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

/**
 * The one path by which a filter change becomes a frame, a URL and a query.
 *
 * Replaying a frame runs through here too, and needs no guard against
 * recording itself: after `applyView` the refs are *equal* to the frame at
 * the cursor, and `push` drops a frame identical to the current one.
 */
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

/** A new dump invalidates every frame: the paths and types are a different
 *  vocabulary, so the queue restarts rather than carrying over. */
function resetTo(v: ViewState) {
  applyView(v)
  inspected.value = null
  outerOf.value = null
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

async function inspect(row: RowView) {
  inspected.value = row
  outerOf.value = null
  if (row.outer) outerOf.value = (await d.resolveAddress(row.outer)).row
}

function jumpTo(path: string) {
  pathPrefix.value = path
  nameQuery.value = ''
  pathQuery.value = ''
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

// ---------------------------------------------------------------- site dumps

const grabbing = ref('')
const grabPct = ref<number | null>(0)
const grabError = ref('')

/** Only dumps this browser has not already taken. The cached copy records the
 *  manifest id it came from, which is what makes "already have it" answerable
 *  without re-hashing a 37 MB file. */
const offered = computed(() => {
  const have = new Set(cached.value.map((c) => c.source).filter(Boolean))
  return hosted.value.filter((h) => !have.has(h.id))
})

/**
 * Download on demand, never on load. One interaction fetches, caches, and
 * opens the dump, so the offer disappearing from this list is the same
 * gesture that puts it on screen.
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

/** Unload the dump and drop back to the intro screen. The parsed copy stays
 *  in IndexedDB, so it reappears under "Already parsed". */
async function clearDump() {
  // The d.count watcher runs resetTo(), which clears every filter, the frame
  // queue and the URL. Only the things outside that surface are left here.
  await d.reset()
  dragging.value = false
}

/**
 * A link carries a dump hash and a set of filters, but never the dump — 37 MB
 * does not fit in a URL. The recipient either already has that dump in
 * IndexedDB, in which case it opens with the sender's filters intact, or they
 * do not, and they land on the normal intro with a note saying so.
 */
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
    // Not surfaced as an error: a link arriving without its dump is the
    // expected case, and `linkMiss` says so in plainer terms. The pending
    // view stays put so that loading the file by hand still lands on it.
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
      />

      <section class="main">
        <div class="controls">
          <div class="searches">
            <!-- Filter history. Every change to the query surface lands here as
                 a frame, so stepping back is stepping back through views. -->
            <div class="frames mono">
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
          :shared-digits="d.sharedAddressDigits.value"
          :sort="sort"
          :descending="descending"
          :fetch-window="d.fetchWindow"
          @inspect="inspect"
          @sort="setSort"
        />

        <footer class="status mono">
          <span>{{ fmt.format(d.total.value) }} / {{ fmt.format(d.count.value) }} shown</span>
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
          <button @click="inspected = null">×</button>
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
        <button class="scope" @click="jumpTo(inspected.path)">Scope tree to this object</button>
      </aside>
    </main>

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
