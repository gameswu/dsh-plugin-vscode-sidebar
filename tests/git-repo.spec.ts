/**
 * Repo discovery & numstat coverage: real git checkouts in temp trees.
 * - numstat parses `git diff --numstat -z` into per-path counts (binary → null).
 * - discoverRepos finds the enclosing repo first, then nested checkouts,
 *   honoring the default exclusions and user-supplied extras.
 * - status() merges numstat counts into its entries.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_GIT_EXCLUDES, discoverRepos, enclosingRepoRoot, ignoredPaths, isExcludedName,
  numstat, parseExcludePatterns, status,
} from '../src/git.ts'

const roots: string[] = []

/** One throwaway temp dir, tracked for cleanup. */
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-bs-git-${label}-`))
  roots.push(dir)
  return dir
}

/** Compare path lists independent of separator/case (git may re-report paths). */
function key(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** Run git in `cwd`; throw on failure. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A repo with one committed file and (optionally) a dirty worktree. */
function makeRepo(dir: string, name = 'repo'): string {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-qm', 'init')
  return root
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('git repo discovery', () => {
  it('finds the enclosing repo of a nested directory (walk-up)', async () => {
    const root = makeRepo(tempDir('walkup'))
    const sub = join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const found = await enclosingRepoRoot(sub)
    expect(key(found ?? '')).toBe(key(root))
  })

  it('returns null outside any work tree', async () => {
    const dir = tempDir('outside')
    expect(await enclosingRepoRoot(dir)).toBeNull()
  })

  it('lists the enclosing repo first, then nested repos under cwd', async () => {
    const dir = tempDir('nested')
    const root = makeRepo(dir)          // cwd IS a repo
    const inner = makeRepo(root, 'project-a') // nested checkout inside it
    const repos = await discoverRepos(root, { maxDepth: 2 })
    expect(repos.map(repo => key(repo.root))).toEqual([key(root), key(inner)])
    expect(repos[0]!.branch).toBeDefined()
  })

  it('discovers nested repos when the cwd itself is not a repo', async () => {
    const dir = tempDir('plain')
    const inner = makeRepo(dir, 'work')
    const repos = await discoverRepos(dir, { maxDepth: 2 })
    expect(repos.map(repo => key(repo.root))).toEqual([key(inner)])
  })

  it('skips excluded directories (defaults + user extras)', async () => {
    const dir = tempDir('exclude')
    const inNodeModules = makeRepo(join(dir, 'node_modules'), 'pkg')
    const inVendor = makeRepo(join(dir, 'vendor'), 'lib')
    const visible = makeRepo(dir, 'app')
    const defaultOnly = await discoverRepos(dir, { maxDepth: 3 })
    expect(defaultOnly.map(repo => key(repo.root))).not.toContain(key(inNodeModules))
    expect(defaultOnly.map(repo => key(repo.root))).toContain(key(inVendor))
    expect(defaultOnly.map(repo => key(repo.root))).toContain(key(visible))
    const withExtras = await discoverRepos(dir, { maxDepth: 3, excludes: ['vendor'] })
    expect(withExtras.map(repo => key(repo.root))).not.toContain(key(inNodeModules))
    expect(withExtras.map(repo => key(repo.root))).not.toContain(key(inVendor))
    expect(withExtras.map(repo => key(repo.root))).toContain(key(visible))
  })

  it('parses user exclusion strings and matches names case-insensitively', () => {
    expect(parseExcludePatterns('vendor, dist  build/')).toEqual(['vendor', 'dist', 'build'])
    expect(parseExcludePatterns('')).toEqual([])
    expect(parseExcludePatterns(undefined)).toEqual([])
    expect(isExcludedName('NODE_MODULES', DEFAULT_GIT_EXCLUDES)).toBe(true)
    expect(isExcludedName('src', DEFAULT_GIT_EXCLUDES)).toBe(false)
  })
})

describe('git numstat & status counts', () => {
  it('parses numstat -z output into per-path counts (binary → null)', async () => {
    const root = makeRepo(tempDir('numstat'))
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    const counts = await numstat(root, false)
    const a = counts.get('a.txt')
    expect(a).toBeDefined()
    expect(a!.added).toBe(2)
    expect(a!.deleted).toBe(0)
    // Untracked binaries show no counts at all (git diff ignores untracked
    // files) — stage it to force a binary row with '-' numbers.
    git(root, 'add', 'bin.dat')
    const staged = await numstat(root, true)
    const bin = staged.get('bin.dat')
    expect(bin).toBeDefined()
    expect(bin!.added).toBeNull()
    expect(bin!.deleted).toBeNull()
  })

  it('merges numstat counts into status entries', async () => {
    const root = makeRepo(tempDir('statusnums'))
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    const result = await status(root)
    expect(result.isRepo).toBe(true)
    const entry = result.entries.find(candidate => candidate.path === 'a.txt')
    expect(entry).toBeDefined()
    expect(entry!.added).toBe(2)
    expect(entry!.deleted).toBe(0)
  })

  it('reports aheadBehind as null without an upstream', async () => {
    const root = makeRepo(tempDir('noupstream'))
    const result = await status(root)
    expect(result.aheadBehind).toBeNull()
  })
})

describe('gitignore-based visibility', () => {
  it('ignoredPaths reports exactly the names .gitignore excludes', async () => {
    const root = makeRepo(tempDir('ignored'))
    writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'build.log'), 'x')
    writeFileSync(join(root, 'keep.txt'), 'x')
    const ignored = await ignoredPaths(root, ['dist', 'build.log', 'keep.txt', '.gitignore'])
    expect(ignored).toEqual(new Set(['dist', 'build.log']))
  })

  it('resolves to an empty set outside any work tree', async () => {
    const dir = tempDir('noignore')
    mkdirSync(dir, { recursive: true })
    expect(await ignoredPaths(dir, ['a.txt', 'b.txt'])).toEqual(new Set())
  })
})
