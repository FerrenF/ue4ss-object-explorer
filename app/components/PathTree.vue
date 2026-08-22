<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import type { TreeChild } from '../lib/dump-store'

const props = defineProps<{
  modelValue: string
  fetchChildren: (prefix: string) => Promise<{ prefix: string; children: TreeChild[] }>
  version: number
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'dump', path: string): void
}>()

interface TreeNode extends TreeChild {
  depth: number
  open: boolean
  children: TreeNode[] | null
  loading: boolean
}

const roots = ref<TreeNode[]>([])

function toNode(c: TreeChild, depth: number): TreeNode {
  return { ...c, depth, open: false, children: null, loading: false }
}

async function loadRoots() {
  roots.value = []
  const { children } = await props.fetchChildren('')
  roots.value = children.map((c) => toNode(c, 0))
  if (roots.value.length === 1 && roots.value[0]) toggle(roots.value[0])
}

async function toggle(node: TreeNode) {
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

const order = ref<'count' | 'alpha'>('count')
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function arrange(nodes: TreeNode[]): TreeNode[] {
  const by =
    order.value === 'alpha'
      ? (a: TreeNode, b: TreeNode) => collator.compare(a.segment, b.segment)
      : (a: TreeNode, b: TreeNode) => b.count - a.count || collator.compare(a.segment, b.segment)
  return nodes.slice().sort(by)
}

function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of arrange(nodes)) {
    out.push(n)
    if (n.open && n.children) flatten(n.children, out)
  }
  return out
}

// ------------------------------------------------------------ context menu

const menu = ref<{ x: number; y: number; path: string; label: string } | null>(null)
const menuEl = ref<HTMLElement | null>(null)

let armed = false

function arm() {
  if (armed) return
  armed = true
  window.addEventListener('pointerdown', onOutside)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', closeMenu)
  // Capture, because the scroll that matters happens in .scroll, not on window.
  window.addEventListener('scroll', closeMenu, true)
}

function disarm() {
  if (!armed) return
  armed = false
  window.removeEventListener('pointerdown', onOutside)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', closeMenu)
  window.removeEventListener('scroll', closeMenu, true)
}

function onOutside(e: PointerEvent) {
  if (menuEl.value?.contains(e.target as Node)) return
  closeMenu()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu()
}

function openMenu(e: MouseEvent, node: TreeNode) {
  // Clamped so a right-click near the bottom or right edge does not open the
  // menu off-screen; the sizes are the menu's own, which is fixed content.
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - 240),
    y: Math.min(e.clientY, window.innerHeight - 60),
    path: node.path,
    label: node.segment,
  }
  requestAnimationFrame(arm)
}

function closeMenu() {
  menu.value = null
  disarm()
}

function dumpFromMenu() {
  if (menu.value) emit('dump', menu.value.path)
  closeMenu()
}

const fmt = new Intl.NumberFormat()
onMounted(loadRoots)
onBeforeUnmount(disarm)
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
        :class="{ active: modelValue === node.path, aimed: menu?.path === node.path }"
        :style="{ paddingLeft: 8 + node.depth * 13 + 'px' }"
        @contextmenu.prevent="openMenu($event, node)"
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

    <!-- Teleported out of the .spine, which scrolls and clips. -->
    <Teleport to="body">
      <div
        v-if="menu"
        ref="menuEl"
        class="menu mono"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @contextmenu.prevent
      >
        <button @click="dumpFromMenu">
          Dump tree under <b>{{ menu.label }}</b>
        </button>
      </div>
    </Teleport>
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
/* Keeps the right-clicked row identifiable while the menu is over it. */
.node.aimed {
  background: var(--raise);
  box-shadow: inset 2px 0 0 var(--amber);
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

/* Teleported to <body>, but Vue still stamps it with this component's scope
   id, so these rules reach it. */
.menu {
  position: fixed;
  z-index: 50;
  min-width: 210px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 3px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 45%);
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 11px;
  color: var(--ink);
  background: none;
  border: none;
  border-radius: 2px;
  padding: 7px 9px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu button b {
  font-weight: 400;
  color: var(--amber);
}
.menu button:hover {
  background: var(--raise);
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
