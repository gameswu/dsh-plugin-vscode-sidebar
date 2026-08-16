/**
 * The shared heartbeat: ONE 1s interval for the whole page instead of every
 * panel running its own timer. Subscribers divide the tick into their own
 * cadences (every N ticks). The interval runs only while at least one
 * subscriber exists.
 */
const listeners = new Set<() => void>()
let timer: number | undefined

/** Subscribe to the 1s heartbeat; the shared interval lives while anyone listens. */
export function subscribeHeartbeat(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    timer = window.setInterval(() => {
      for (const fn of [...listeners]) fn()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}
