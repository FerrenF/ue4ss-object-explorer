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

/**
 * Ordering is applied at render rather than at fetch, so flipping it costs a
 * re-sort of the nodes already on screen and never re-walks the store. The
 * store hands back count order; `localeCompare` with numeric collation is
 * what makes `Item_2` precede `Item_10` in the alphabetical mode.
 */
const order = ref<'count' | 'alpha'>('count')
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function arrange(nodes: Node[]): Node[] {
  const by =
    order.value === 'alpha'
      ? (a: Node, b: Node) => collator.compare(a.segment, b.segment)
      : (a: Node, b: Node) => b.count - a.count || collator.compare(a.segment, b.segment)
  return nodes.slice().sort(by)
}

function flatten(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of arrange(nodes)) {
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
      <div class="head-tools">
        <div class="order" role="group" aria-label="Sort tree">
          <button
            :class="{ on: order === 'count' }"
            title="Sort by number of objects"
            @click="order = 'count'"
          >
            count
          </button>
          <button
            :class="{ on: order === 'alpha' }"
            title="Sort alphabetically"
            @click="order = 'alpha'"
          >
            a–z
          </button>
        </div>
        <button v-if="modelValue" class="clear" @click="emit('update:modelValue', '')">clear</button>
      </div>
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

.head-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.clear {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
}

.order {
  display: flex;
  border: 1px solid var(--rule);
  border-radius: 3px;
  overflow: hidden;
}
.order button {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 3px 7px;
  color: var(--dim);
  background: none;
  border: none;
  cursor: pointer;
}
.order button + button {
  border-left: 1px solid var(--rule);
}
.order button:hover {
  color: var(--ink);
}
.order button.on {
  color: var(--ink-strong);
  background: var(--raise);
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
