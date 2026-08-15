/**
 * History lane-graph builder coverage: the pure extendGraph turns parent
 * hashes into per-row columns (tips), verticals, joins and merge-parent
 * slants, and stays stable across page boundaries.
 */
import { describe, expect, it } from 'vitest'
import { emptyGraphState, extendGraph, GRAPH_PALETTE } from '../src/client/git-graph.ts'
import type { GitLogEntry } from '../src/client/api.ts'

/** A synthetic commit (newest-first list order is the caller's job). */
function commit(hashFull: string, parents: string[] = []): GitLogEntry {
  return { hash: hashFull.slice(0, 7), hashFull, subject: hashFull, author: 'a', date: '2024-01-01', refs: '', parents }
}

describe('extendGraph', () => {
  it('keeps a linear history on one lane and ends at the root', () => {
    const a = commit('a'.repeat(40), ['b'.repeat(40)])
    const b = commit('b'.repeat(40), ['c'.repeat(40)])
    const c = commit('c'.repeat(40))
    const { rows, state } = extendGraph(emptyGraphState(), [a, b, c])
    expect(rows.map(row => row.col)).toEqual([0, 0, 0])
    // a and b continue the lane (vertical drawn); c ends it.
    expect(rows[0]!.lanes).toEqual([true])
    expect(rows[1]!.lanes).toEqual([true])
    expect(rows[2]!.lanes).toEqual([false])
    expect(rows[0]!.slants).toEqual([])
    // The tip after the page is null (the lane ended at the root).
    expect(state.lanes).toEqual([{ tip: null, color: 0 }])
  })

  it('starts a new lane for a merge parent and connects it with a slant', () => {
    const merge = commit('m'.repeat(40), ['a'.repeat(40), 'b'.repeat(40)])
    const { rows, state } = extendGraph(emptyGraphState(), [merge])
    const row = rows[0]!
    expect(row.col).toBe(0)
    expect(row.slants).toEqual([{ from: 0, to: 1 }])
    // Lane 0 continues (first parent), lane 1 is the new merge-parent lane.
    expect(row.lanes).toEqual([true, true])
    expect(state.lanes.map(lane => lane.tip)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  })

  it('joins a lane when the first parent is an existing tip', () => {
    const m = commit('m'.repeat(40), ['x'.repeat(40), 'b'.repeat(40)])
    const { rows: first } = extendGraph(emptyGraphState(), [m])
    const b = commit('b'.repeat(40), ['x'.repeat(40)])
    const extended = extendGraph({ lanes: first[0]!.lanes.map((tip, i) => ({ tip: tip ? ['x'.repeat(40), 'b'.repeat(40)][i]! : null, color: i })), nextColor: 2 }, [b])
    // b continues the second lane (col 1) and joins the first lane's tip x.
    const row = extended.rows[0]!
    expect(row.col).toBe(1)
    expect(row.slants).toEqual([{ from: 1, to: 0 }])
    expect(row.lanes).toEqual([true, false])
  })

  it('keeps columns and colors stable across page boundaries', () => {
    const first = extendGraph(emptyGraphState(), [
      commit('m'.repeat(40), ['a'.repeat(40), 'b'.repeat(40)]),
    ])
    expect(first.state.lanes.map(lane => lane.tip)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
    const second = extendGraph(first.state, [
      commit('b'.repeat(40), ['z'.repeat(40)]),
      commit('a'.repeat(40), ['z'.repeat(40)]),
    ])
    expect(second.rows.map(row => row.col)).toEqual([1, 0])
    // The merge-parent lane kept its own color (1), the main lane color 0.
    expect(second.rows[0]!.colors).toEqual(first.state.lanes.map(lane => lane.color))
    expect(GRAPH_PALETTE.length).toBeGreaterThan(0)
  })
})
