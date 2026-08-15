/**
 * History lane-graph builder for the source-control panel: turns the flat
 * `git log` rows (with parent hashes) into a per-row column model the
 * renderer draws as VSCode-git-graph-style lanes — one column per active
 * branch tip, vertical lines where a lane continues, slanted connectors
 * where a lane joins another or a merge parent starts a new lane.
 *
 * The builder is PURE and stateful across log pages: the caller keeps the
 * returned {@link GraphState} (lane tips + color cursor) and feeds the next
 * page into it, so a lane's column and color stay stable across "load
 * more" batches. Unit-tested without a DOM in tests/git-graph.spec.ts.
 */
import type { GitLogEntry } from './api.ts'

/** The lane-color palette (indexed by the lane's assigned color). */
export const GRAPH_PALETTE: readonly string[] = [
  '#4f8cff', // blue
  '#7b61ff', // violet
  '#2ea86b', // green
  '#e8a33d', // amber
  '#e85d75', // red
  '#20b8c8', // teal
  '#a371f7', // purple
  '#d29922', // dark amber
  '#f778ba', // pink
  '#3fb950', // bright green
]

/** One lane: the tip commit it is waiting for (null = the lane ended). */
export interface GraphLane {
  tip: string | null
  /** Index into {@link GRAPH_PALETTE}. */
  color: number
}

/** A slanted connector drawn from the row's node to another column below. */
export interface GraphSlant {
  /** The node's column. */
  from: number
  /** The target column (a joined lane or a new merge-parent lane). */
  to: number
}

/** The per-row drawing model (aligned 1:1 with the log rows). */
export interface GraphRow {
  /** The row's commit (full hash keys the alignment). */
  hashFull: string
  /** The commit node's column. */
  col: number
  /** lane-present per column AFTER the mutation (true draws a vertical). */
  lanes: boolean[]
  /** Color index per column (for verticals and the node). */
  colors: number[]
  /** Slanted connectors leaving this row's node. */
  slants: GraphSlant[]
}

/** The cross-page graph state: lane tips + the next palette color. */
export interface GraphState {
  lanes: GraphLane[]
  nextColor: number
}

/** The initial (empty) graph state. */
export function emptyGraphState(): GraphState {
  return { lanes: [], nextColor: 0 }
}

/**
 * Extend the graph with one page of commits (newest first, as `git log`
 * yields them). Returns the per-row drawing models plus the state to carry
 * into the next page. The input state is never mutated.
 */
export function extendGraph(state: GraphState, commits: readonly GitLogEntry[]): { rows: GraphRow[]; state: GraphState } {
  const lanes = state.lanes.map(lane => ({ ...lane }))
  let nextColor = state.nextColor
  const rows: GraphRow[] = []

  for (const commit of commits) {
    // The commit continues the lane whose tip it is; a commit that matches
    // NO tip starts a fresh lane (first commit of a page, a new root).
    let col = lanes.findIndex(lane => lane.tip === commit.hashFull)
    if (col === -1) {
      col = lanes.length
      lanes.push({ tip: commit.hashFull, color: nextColor })
      nextColor += 1
    }
    const slants: GraphSlant[] = []
    const firstParent = commit.parents[0]
    const lane = lanes[col]!

    if (firstParent !== undefined) {
      // The first parent either continues this column or JOINS an existing
      // tip (a branch merged back — the classic `/` connector).
      const joined = lanes.findIndex(candidate => candidate.tip === firstParent)
      if (joined !== -1 && joined !== col) {
        lanes[col] = { ...lane, tip: null }
        slants.push({ from: col, to: joined })
      } else {
        lanes[col] = { ...lane, tip: firstParent }
      }
    } else {
      // A root commit: the lane ends here.
      lanes[col] = { ...lane, tip: null }
    }

    // Merge parents beyond the first start NEW lanes (the `\` connectors).
    for (let index = 1; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index]!
      if (lanes.some(lane => lane.tip === parent)) continue
      lanes.push({ tip: parent, color: nextColor })
      nextColor += 1
      slants.push({ from: col, to: lanes.length - 1 })
    }

    rows.push({
      hashFull: commit.hashFull,
      col,
      lanes: lanes.map(lane => lane.tip !== null),
      colors: lanes.map(lane => lane.color),
      slants,
    })
  }

  return { rows, state: { lanes, nextColor } }
}
