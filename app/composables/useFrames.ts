import { ref, computed, shallowRef } from 'vue'
import { emptyView, sameView, type ViewState } from '../lib/view-state'

/**
 * The filter history: a queue of frames plus a cursor into it.
 *
 * This is deliberately the app's own history rather than the browser's.
 * Browser history cannot be truncated — pushing after going back leaves the
 * forward entries reachable by gesture — and it is shared with whatever the
 * user did before arriving here, so "back" would eventually walk off the
 * site mid-investigation. Owning the queue means the URL can be rewritten in
 * place (replaceState) and still be exactly as linkable.
 */
export function useFrames() {
  const frames = shallowRef<ViewState[]>([emptyView()])
  const index = ref(0)

  const current = computed(() => frames.value[index.value] ?? emptyView())
  const canBack = computed(() => index.value > 0)
  const canForward = computed(() => index.value < frames.value.length - 1)

  /**
   * Record a frame. A change made from anywhere but the newest frame discards
   * everything after the cursor first: the user has branched, and the frames
   * they walked back past are no longer reachable from where they now are.
   *
   * The equality check is what makes replay safe. Stepping back sets the
   * filter refs to the frame at the cursor, which re-triggers the watchers
   * that call this — and a frame identical to the current one is dropped, so
   * no flag is needed to tell a replay from a real change.
   */
  function push(v: ViewState) {
    if (sameView(v, current.value)) return
    const kept = frames.value.slice(0, index.value + 1)
    kept.push(v)
    frames.value = kept
    index.value = kept.length - 1
  }

  /** Drop the whole queue — used when a different dump is opened. */
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
    reset,
    back: () => go(-1),
    forward: () => go(1),
  }
}
