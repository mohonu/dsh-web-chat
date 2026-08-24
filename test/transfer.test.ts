/**
 * Unit tests for the workspace-targeted transfer logic.
 *
 * Run with the Node built-in test runner + native type stripping (Node >= 22.6,
 * enabled by default since 23.6):
 *   node --test test/
 *
 * These tests drive `transferToHarnessSession` with hand-built fake ctx /
 * registry / persistence objects — no cordis host, no LLM, no filesystem
 * beyond `mkdtemp` for the path-resolution case. Distillation is disabled via
 * `{ distill: false }` so the harness LLM is never invoked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { renderTranscriptMarkdown, transferToHarnessSession } from '../src/transfer.ts'
import type { WebChatTranscript } from '../src/protocol.ts'

const transcript: WebChatTranscript = {
  id: 'chat-test-000001',
  title: '测试对话',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  model: 'deepseek-chat',
  messages: [
    { id: 'm1', role: 'user', content: '你好', ts: Date.now() },
    { id: 'm2', role: 'assistant', content: '你好！', ts: Date.now() },
  ],
  streaming: false,
}

const NO_DISTILL = { distill: false, provider: '', model: '' }

/** A fake workspace with a recording `attachSession`. */
function makeWorkspace(id: string, path: string, opts?: { attachError?: Error }) {
  const calls: string[] = []
  return {
    id,
    path,
    title: 'ws',
    sessionIds: [] as string[],
    attachSession: async (sessionId: string) => {
      if (opts?.attachError !== undefined) throw opts.attachError
      calls.push(sessionId)
    },
    _calls: calls,
  }
}

/** A fake registry whose `get`/`resolveByPath` return the given workspace. */
function makeRegistry(workspace: ReturnType<typeof makeWorkspace> | undefined) {
  return {
    get: (_id: unknown) => workspace,
    resolveByPath: async (_path: string) => workspace,
  }
}

/** A fake session-persistence backend recording create/append calls. */
function makePersistence() {
  const created: Array<{ cwd: string }> = []
  const appended: unknown[] = []
  return {
    create: async (header: { cwd: string }) => { created.push(header) },
    append: async (_id: unknown, events: unknown) => { appended.push(events) },
    created,
    appended,
  }
}

/** A minimal ctx exposing the two services the transfer path reads. */
function makeCtx(registry: unknown, persistence: unknown): Context {
  return {
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return persistence
      return undefined
    },
    sessions: { create: () => {} },
  } as unknown as Context
}

test('workspaceId 转移：cwd 设为工作区路径并 attach', async () => {
  const ws = makeWorkspace('ws-1', '/srv/project')
  const persistence = makePersistence()
  const ctx = makeCtx(makeRegistry(ws), persistence)

  const result = await transferToHarnessSession(ctx, { transcript, workspace: { workspaceId: 'ws-1' } }, NO_DISTILL)

  assert.equal(result.attached, true)
  assert.equal(result.workspaceId, 'ws-1')
  assert.equal(ws._calls.length, 1)
  assert.equal(persistence.created[0]!.cwd, '/srv/project')
  assert.equal(persistence.appended.length, 1)
})

test('未知 workspaceId：在持久化前抛错，不留孤儿会话', async () => {
  const persistence = makePersistence()
  const ctx = makeCtx(makeRegistry(undefined), persistence)

  await assert.rejects(
    transferToHarnessSession(ctx, { transcript, workspace: { workspaceId: 'nope' } }, NO_DISTILL),
    /不存在或已删除/,
  )
  assert.equal(persistence.created.length, 0)
})

test('无工作区：未分组，cwd 回退到 process.cwd()', async () => {
  const persistence = makePersistence()
  const ctx = makeCtx(makeRegistry(undefined), persistence)

  const result = await transferToHarnessSession(ctx, { transcript }, NO_DISTILL)

  assert.equal(result.attached, false)
  assert.equal(result.workspaceId, undefined)
  assert.equal(persistence.created[0]!.cwd, process.cwd())
})

test('attach 失败：会话仍创建，返回 attached=false', async () => {
  const ws = makeWorkspace('ws-1', '/srv/project', { attachError: new Error('dir gone') })
  const persistence = makePersistence()
  const ctx = makeCtx(makeRegistry(ws), persistence)

  const result = await transferToHarnessSession(ctx, { transcript, workspace: { workspaceId: 'ws-1' } }, NO_DISTILL)

  assert.equal(result.attached, false)
  assert.equal(result.workspaceId, undefined)
  assert.equal(persistence.created.length, 1)
  assert.equal(persistence.appended.length, 1)
})

test('workspace.path 转移：realpath 规范化后 resolveByPath 并 attach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webchat-test-'))
  const ws = makeWorkspace('ws-2', dir)
  const persistence = makePersistence()
  const ctx = makeCtx(makeRegistry(ws), persistence)

  const result = await transferToHarnessSession(ctx, { transcript, workspace: { path: dir } }, NO_DISTILL)

  assert.equal(result.attached, true)
  assert.equal(result.workspaceId, 'ws-2')
  assert.equal(ws._calls.length, 1)
  assert.ok(persistence.created[0]!.cwd.startsWith('/'), 'cwd 应为绝对路径')
})

test('renderTranscriptMarkdown 标注图片附件', () => {
  const withImages: WebChatTranscript = {
    ...transcript,
    messages: [
      { id: 'm1', role: 'user', content: '看看这个', ts: Date.now(), attachments: ['/tmp/a.png', '/tmp/b.png'] },
      { id: 'm2', role: 'assistant', content: '好的', ts: Date.now() },
    ],
  }
  const markdown = renderTranscriptMarkdown(withImages)
  assert.match(markdown, /图片附件：\/tmp\/a\.png、\/tmp\/b\.png/)
})
