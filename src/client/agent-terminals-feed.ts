/**
 * The agent-terminal list feed: ONE WebSocket per session shared by every
 * consumer (the sidebar's tab mirror and the Tasks page's terminal section
 * used to each open their own socket with their own reconnect loop). The
 * feed owns the connection: raw frames fan out to subscribers, one retry
 * loop with a failure cap, and the socket closes when the last subscriber
 * goes away.
 */
type FrameListener = (frame: string) => void

interface FeedSession {
  socket: WebSocket | null
  subscribers: Map<number, FrameListener>
  failures: number
  retry: number | undefined
  closed: boolean
  nextId: number
}

const sessions = new Map<string, FeedSession>()

/** How many consecutive list-socket failures stop the reconnect loop. */
const FEED_FAILURE_LIMIT = 3

/**
 * Subscribe to the raw frames of one session's agent-terminal list.
 * @param sessionId - the session whose terminals to watch.
 * @param onFrame - one raw JSON frame per push.
 * @param active - when false, the subscription stays dormant (no socket).
 * @returns the disposer (the socket closes once the last subscriber goes).
 */
export function subscribeAgentTerminalFeed(
  sessionId: string,
  onFrame: FrameListener,
  active: boolean,
): () => void {
  let feed = sessions.get(sessionId)
  if (feed === undefined) {
    feed = {
      socket: null,
      subscribers: new Map(),
      failures: 0,
      retry: undefined,
      closed: false,
      nextId: 0,
    }
    sessions.set(sessionId, feed)
  }
  const id = feed.nextId++
  const connect = (): void => {
    if (feed!.closed || !active) return
    const url = new URL('/sidebar/ws/agent-terminals', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = new URLSearchParams({ sessionId }).toString()
    const socket = new WebSocket(url.toString())
    feed!.socket = socket
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      for (const listener of [...feed!.subscribers.values()]) listener(event.data)
    }
    socket.onclose = () => {
      if (feed!.closed) return
      feed!.socket = null
      feed!.failures += 1
      if (feed!.failures >= FEED_FAILURE_LIMIT) return
      feed!.retry = window.setTimeout(connect, 2000)
    }
    socket.onerror = () => { socket.close() }
  }

  const ensure = (nextActive: boolean): void => {
    if (nextActive && feed!.socket === null && feed!.failures < FEED_FAILURE_LIMIT) connect()
    if (!nextActive && feed!.socket !== null) {
      // Dormant: drop the socket (the host's bare-drop semantics keep the
      // terminals alive; re-subscribing reconnects).
      feed!.socket.close()
      feed!.socket = null
    }
  }

  feed.subscribers.set(id, onFrame)
  ensure(active)
  return () => {
    feed!.subscribers.delete(id)
    if (feed!.subscribers.size === 0) {
      feed!.closed = true
      window.clearTimeout(feed!.retry)
      feed!.socket?.close()
      feed!.socket = null
      sessions.delete(sessionId)
    }
  }
}
