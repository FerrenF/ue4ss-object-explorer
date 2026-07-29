<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useDump, type RowView } from './composables/useDump'
import { hue, abbreviate } from './lib/type-hue'
import { listDumps, dropDump, type CachedDump } from './lib/persist'
import HeaderBar from '@/components/HeaderBar.vue'
const d = useDump()

const nameQuery = ref('')
const pathQuery = ref('')
const pathPrefix = ref('')
const activeTypes = ref<number[]>([])
const sort = ref<'natural' | 'path' | 'address' | 'offset'>('natural')
const inspected = ref<RowView | null>(null)
const outerOf = ref<RowView | null>(null)
const cached = ref<CachedDump[]>([])
const showAllTypes = ref(false)
const dragging = ref(false)
const treeVersion = ref(0)

const fmt = new Intl.NumberFormat()

let timer: ReturnType<typeof setTimeout>
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(run, 120)
}

async function run() {
  if (!d.ready.value) return
  await d.runQuery({
    typeIds: activeTypes.value,
    pathPrefix: pathPrefix.value || undefined,
    nameContains: nameQuery.value.trim() || undefined,
    pathContains: pathQuery.value.trim() || undefined,
    sort: sort.value,
  })
}

watch([nameQuery, pathQuery], schedule)
watch([pathPrefix, activeTypes, sort], run, { deep: true })
watch(d.count, () => {
  treeVersion.value++
  pathPrefix.value = ''
  activeTypes.value = []
  inspected.value = null
  run()
})

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

/** Unload the dump and drop back to the intro screen. The parsed copy stays
 *  in IndexedDB, so it reappears under "Already parsed". */
async function clearDump() {
  await d.reset()
  // The d.count watcher clears pathPrefix / activeTypes / inspected; the rest
  // of the query surface is ours.
  nameQuery.value = ''
  pathQuery.value = ''
  sort.value = 'natural'
  showAllTypes.value = false
  outerOf.value = null
  dragging.value = false
}

onMounted(refreshCached)
watch(d.count, refreshCached)

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
            <input v-model="nameQuery" placeholder="search name…" spellcheck="false" />
            <input v-model="pathQuery" placeholder="search full path…" spellcheck="false" />
            <select v-model="sort" class="mono">
              <option value="natural">dump order</option>
              <option value="path">path</option>
              <option value="address">address</option>
              <option value="offset">field offset</option>
            </select>
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
          :fetch-window="d.fetchWindow"
          @inspect="inspect"
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
}
.searches input {
  flex: 1;
}
.searches select {
  flex: none;
  font-size: 11px;
  color: var(--ink);
  background: var(--void);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 0 8px;
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
