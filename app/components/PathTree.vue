<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import type { TreeChild } from '../lib/dump-store'

const props = defineProps<{
  modelValue: string
  fetchChildren: (prefix: string) => Promise<{ prefix: string; children: TreeChild[] }>
  version: number
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

interface Node extends TreeChild {
  depth: number
  open: boolean
  children: Node[] | null
  loading: boolean
}

const roots = ref<Node[]>([])

function toNode(c: TreeChild, depth: number): Node {
  return { ...c, depth, open: false, children: null, loading: false }
}

async function loadRoots() {
  roots.value = []
  const { children } = await props.fetchChildren('')
  roots.value = children.map((c) => toNode(c, 0))
  if (roots.value.length === 1 && roots.value[0]) toggle(roots.value[0])
}

async function toggle(node: Node) {
  if (node.open) {
    node.open = false
    return
  }
  if (!node.children) {
    node.loading = true
    const { children } = await props.fetchChildren(node.path)
    node.children = children.map((c) => toNode(c, node.depth + 1))
    node.loading = false
  }
  node.open = true
}

function flatten(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n)
    if (n.open && n.children) flatten(n.children, out)
  }
  return out
}

const fmt = new Intl.NumberFormat()
onMounted(loadRoots)
watch(() => props.version, loadRoots)
</script>

<template>
  <nav class="spine">
    <div class="spine-head">
      <span class="eyebrow">Script path</span>
      <button v-if="modelValue" class="clear" @click="emit('update:modelValue', '')">clear</button>
    </div>

    <div class="scroll">
      <button
        class="node mono root"
        :class="{ active: modelValue === '' }"
        @click="emit('update:modelValue', '')"
      >
        <span class="seg">all objects</span>
      </button>

      <div
        v-for="node in flatten(roots)"
        :key="node.path"
        class="node mono"
        :class="{ active: modelValue === node.path }"
        :style="{ paddingLeft: 8 + node.depth * 13 + 'px' }"
      >
        <button
          class="twist"
          :class="{ open: node.open, spin: node.loading }"
          @click="toggle(node)"
          :aria-label="node.open ? 'Collapse' : 'Expand'"
        >
          {{ node.count > 1 ? '›' : '·' }}
        </button>
        <button class="pick" @click="emit('update:modelValue', node.path)">
          <span class="sep">{{ node.separator }}</span
          ><span class="seg">{{ node.segment }}</span>
          <span v-if="node.isObject" class="dot" title="An object exists at this exact path" />
          <span class="count">{{ fmt.format(node.count) }}</span>
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.spine {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex: none;
  background: var(--panel);
  border-right: 1px solid var(--rule);
  min-height: 0;
}

.spine-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--rule);
  flex: none;
}

.clear {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
}

.scroll {
  overflow: auto;
  padding: 6px 0 20px;
  flex: 1;
  min-height: 0;
}

.node {
  display: flex;
  align-items: center;
  width: 100%;
  height: 22px;
  font-size: 12px;
  color: var(--ink);
}

.node:hover {
  background: var(--raise);
}
.node.active {
  background: var(--amber-soft);
  color: var(--ink-strong);
}
.node.root {
  padding-left: 21px;
  color: var(--dim);
}

.twist {
  width: 13px;
  flex: none;
  color: var(--dim);
  transition: transform 0.12s ease;
  line-height: 1;
}
.twist.open {
  transform: rotate(90deg);
}
.twist.spin {
  opacity: 0.4;
}

.pick {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  text-align: left;
  padding-right: 10px;
}

.sep {
  color: var(--dimmer);
  flex: none;
}
.seg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--t-container);
  flex: none;
}

.count {
  margin-left: auto;
  font-size: 10px;
  color: var(--dimmer);
  flex: none;
}

@media (max-width: 900px) {
  .spine {
    width: 100%;
    max-height: 40vh;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
}
</style>
