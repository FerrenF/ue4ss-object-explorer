import { ref, computed, shallowRef } from 'vue'
import { emptyView, sameView, type ViewState } from '../lib/view-state'

export const FRAME_LIMIT = 50

export function useFrames() {
  const frames = shallowRef<ViewState[]>([emptyView()])
  const index = ref(0)

  const current = computed(() => frames.value[index.value] ?? emptyView())
  const canBack = computed(() => index.value > 0)
  const canForward = computed(() => index.value < frames.value.length - 1)

  function push(v: ViewState) {
    if (sameView(v, current.value)) return
    const kept = frames.value.slice(0, index.value + 1)
    kept.push(v)

    frames.value = kept.length > FRAME_LIMIT ? kept.slice(kept.length - FRAME_LIMIT) : kept
    index.value = frames.value.length - 1
  }

  function clear() {
    frames.value = [current.value]
    index.value = 0
  }

  function reset(v: ViewState = emptyView()) {
    frames.value = [v]
    index.value = 0
  }

  const go = (delta: number) => {
    const next = index.value + delta
    if (next < 0 || next >= frames.value.length) return null
    index.value = next
    return frames.value[next]!
  }

  return {
    frames,
    index,
    current,
    canBack,
    canForward,
    push,
    clear,
    reset,
    back: () => go(-1),
    forward: () => go(1),
  }
}
