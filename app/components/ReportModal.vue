<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'

const props = defineProps<{
  open: boolean
  root: string
  text: string
  objects: number
  truncated: boolean
  loading: boolean
  error: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const PREVIEW_LINES = 400

const lines = computed(() => (props.text ? props.text.split('\n') : []))
const preview = computed(() => lines.value.slice(0, PREVIEW_LINES).join('\n'))
const hidden = computed(() => Math.max(0, lines.value.length - PREVIEW_LINES))

/** Last path segment, which is what names the file usefully. */
const slug = computed(() => {
  const seg = props.root.split(/[/.:]/).filter(Boolean).pop() || 'objects'
  return seg.replace(/[^\w.-]+/g, '_').slice(0, 60)
})

const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    /* clipboard blocked; the download still works */
  }
}

function save() {
  const blob = new Blob([props.text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug.value}.dump.txt`
  a.click()

  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Escape has to come off the window: the scrim is a plain div, so it never
 *  takes focus and never sees a key event of its own. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      copied.value = false
      window.addEventListener('keydown', onKey)
    } else {
      window.removeEventListener('keydown', onKey)
    }
  },
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const fmt = new Intl.NumberFormat()
</script>

<template>
  <div v-if="open" class="scrim" @click.self="emit('close')">
    <section class="sheet">
      <header>
        <div class="what">
          <p class="eyebrow">Subtree dump</p>
          <p class="root mono" :title="root">{{ root || 'everything' }}</p>
        </div>
        <button class="x" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="meta mono">
        <template v-if="loading">Walking the subtree…</template>
        <span v-else-if="error" class="bad">{{ error }}</span>
        <template v-else>
          <span>{{ fmt.format(objects) }} objects</span>
          <span class="sep">·</span>
          <span>{{ fmt.format(lines.length) }} lines</span>
          <span v-if="truncated" class="sep">·</span>
          <span v-if="truncated" class="warn">capped</span>
        </template>
      </div>

      <pre v-if="!loading && !error" class="body mono">{{ preview }}</pre>
      <p v-if="hidden" class="more mono">
        … {{ fmt.format(hidden) }} more lines. Download or copy for the whole report.
      </p>

      <footer>
        <button class="act" :disabled="loading || !!error" @click="copy">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
        <button class="act primary" :disabled="loading || !!error" @click="save">
          Download .txt
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>

.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--void) 78%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: min(920px, 100%);
  max-height: 100%;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 4px;
  overflow: hidden;
}

header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--rule);
  flex: none;
}
.what {
  min-width: 0;
}
.root {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ink-strong);
  word-break: break-all;
  line-height: 1.5;
}
.x {
  margin-left: auto;
  flex: none;
  font-size: 16px;
  color: var(--dim);
  background: none;
  border: none;
  cursor: pointer;
}
.x:hover {
  color: var(--t-bool);
}

.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--dim);
  border-bottom: 1px solid var(--rule-soft);
  flex: none;
}
.sep {
  color: var(--dimmer);
}
.warn {
  color: var(--amber);
}
.bad {
  color: var(--t-bool);
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 12px 14px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--ink);
  background: var(--void);
  white-space: pre;
  tab-size: 2;
}

.more {
  flex: none;
  margin: 0;
  padding: 7px 14px;
  font-size: 10px;
  color: var(--dimmer);
  background: var(--void);
  border-top: 1px solid var(--rule-soft);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
  flex: none;
}
.act {
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dim);
  background: none;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 7px 12px;
  cursor: pointer;
}
.act:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--dim);
}
.act.primary {
  color: var(--amber);
}
.act.primary:hover:not(:disabled) {
  color: var(--amber);
  border-color: var(--amber);
}
.act:disabled {
  color: var(--dimmer);
  cursor: default;
}
</style>
