/**
 * Unit tests for the all-session listing used by the "continue into an
 * existing session" picker. Drives `listHarnessSessions` with a hand-built
 * ctx — no cordis host, no filesystem.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { listHarnessSessions } from '../src/harness.ts'

function fakeLiveSession(id: string, cwd: string | undefined, createdAt: number) {
  return { id, header: { cwd, createdAt } }
}

function makeCtx(opts: {
  live: Array<{ id: string; header: { cwd?: string; createdAt: number } }>
  cold?: Array<{ id: string; cwd?: string; createdAt: number }>
  liveValues?: Record<string, Record<string, unknown>>
  coldValues?: Record<string, Record<string, unknown>>
  running?: string[]
}): Context {
  const { live, cold = [], liveValues = {}, coldValues = {}, running = [] } = opts
  return {
    get(name: string) {
      if (name === 'sessionPersistence') return { list: async () => cold }
      if (name === 'sessionProjections') return { snapshot: (session: { id: string }) => ({ values: liveValues[session.id] }) }
      if (name === 'sessionProjectionCache') return { cachedSnapshot: (meta: { id: string }) => ({ values: coldValues[meta.id] }) }
      if (name === 'agents') return { get: (id: string) => (running.includes(id) ? { status: 'running' } : undefined) }
      return undefined
    },
    sessions: { list: () => live },
  } as unknown as Context
}

test('listHarnessSessions 合并 live 与 cold 并去重、跳过无 cwd 的 cold 会话', async () => {
  const ctx = makeCtx({
    live: [fakeLiveSession('live-1', '/srv/a', 300)],
    cold: [
      { id: 'cold-1', cwd: '/srv/b', createdAt: 200 },
      { id: 'live-1', cwd: '/srv/a', createdAt: 300 }, // duplicate — live wins
      { id: 'cold-no-cwd', cwd: undefined, createdAt: 100 }, // skipped
    ],
    liveValues: { 'live-1': { title: '标题A' } },
    coldValues: { 'cold-1': { title: '标题B' } },
    running: ['live-1'],
  })

  const rows = await listHarnessSessions(ctx)

  assert.deepEqual(rows.map(row => row.sessionId), ['live-1', 'cold-1'])
  assert.equal(rows[0]!.title, '标题A')
  assert.equal(rows[0]!.running, true)
  assert.equal(rows[1]!.title, '标题B')
  assert.equal(rows[1]!.running, false)
})

test('listHarnessSessions 无投影时回退到 cwd basename', async () => {
  const ctx = makeCtx({
    live: [],
    cold: [{ id: 'cold-1', cwd: '/srv/项目根目录', createdAt: 100 }],
  })

  const rows = await listHarnessSessions(ctx)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.title, '项目根目录')
})

test('listHarnessSessions 读取 blank 投影并按 createdAt 倒序', async () => {
  const ctx = makeCtx({
    live: [],
    cold: [
      { id: 'older', cwd: '/srv/x', createdAt: 100 },
      { id: 'newer', cwd: '/srv/y', createdAt: 200 },
    ],
    coldValues: {
      older: { sessionListMetadata: { blank: false, lastPromptAt: null } },
      newer: { sessionListMetadata: { blank: true, lastPromptAt: null } },
    },
  })

  const rows = await listHarnessSessions(ctx)
  assert.deepEqual(rows.map(row => row.sessionId), ['newer', 'older'])
  assert.equal(rows[0]!.blank, true)
  assert.equal(rows[1]!.blank, false)
})
