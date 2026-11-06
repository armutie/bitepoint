/** Identical generation for synchronous tools and cooperative browser loading. */
export function finishBuild<T>(steps: Generator<void, T>): T {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

/** Yield to input and painting between bounded pieces, retaining deterministic output. */
export async function runBuild<T>(steps: Generator<void, T>, current: () => boolean,
  report?: (longestSliceMs: number) => void): Promise<T | null> {
  let longest = 0
  try {
    while (current()) {
      const begin = performance.now()
      let step = steps.next()
      while (!step.done && performance.now() - begin < 6) {
        step = steps.next()
      }
      longest = Math.max(longest, performance.now() - begin)
      if (step.done) { report?.(longest); return step.value }
      // Prefer prioritized browser yielding; the fallback also lets input and paint run.
      await ((globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler?.yield() ?? new Promise<void>(resolve => setTimeout(resolve, 0)))
    }
    return null
  } finally {
    steps.return(undefined as never)
  }
}
