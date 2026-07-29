
<script setup lang="ts">

const props = defineProps<{
    onPick: (event: Event) => void
    onClear: () => Promise<void>
    showsClear: boolean
}>();
const config = useRuntimeConfig()
const homeUrl = config.public.urlBase;
const iconUrl = "/img/icon_civcore.webp"
</script>

<template>
    <div class="bar">
     <div class="brand">
        <img :src="iconUrl"/>
        <span class="mark mono">[<NuxtLink :href="homeUrl" style="color: inherit; text-decoration: none;"><i>UE4SS Object Explorer</i></NuxtLink>]</span>
      </div>

      <slot/>

      <div class="actions">
        <label class="load">
          <input type="file" accept=".txt,.log,.dump" hidden @change="onPick" />
          <span>Load dump</span>
        </label>

        <button v-if="showsClear" type="button" class="load clear" @click="onClear">
          Clear dump
        </button>
      </div>
    </div>
</template>

<style scoped>

.bar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  height: 46px;
  flex: none;
  background: var(--panel);
  border-bottom: 1px solid var(--rule);
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mark {
  color: var(--dimmer);
  font-size: 14px;
  font-weight: 700;
}
.mark i {
  color: var(--amber);
  font-style: normal;
}
.title {
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-strong);
}

.readout {
  font-size: 11px;
  color: var(--dim);
  display: flex;
  gap: 8px;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}
.readout .file {
  color: var(--ink);
}
.sep {
  color: var(--dimmer);
}
.warn {
  color: var(--t-bool);
}

.actions {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.load {
  flex: none;
  font-family: inherit;
  line-height: 1;
  background: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--amber);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 6px 11px;
  cursor: pointer;
}
.load:hover {
  border-color: var(--amber);
}

.clear {
  color: var(--dim);
}
.clear:hover {
  color: var(--t-bool);
  border-color: var(--t-bool);
}

</style>
