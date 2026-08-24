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
import { chunkTranscript, renderTranscriptMarkdown, transcriptUserMessageEvent, transferToHarnessSession } from '../src/transfer.ts'
import type { WebChatMessage, WebChatTranscript } from '../src/protocol.ts'

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

test('transcriptUserMessageEvent 携带指定 seq 与 surfaceOp', () => {
  const event = transcriptUserMessageEvent('hello', 7)
  assert.equal(event.type, 'user/message')
  assert.equal(event.seq, 7)
  assert.equal(event.surfaceOp, 'append')
  assert.equal(event.data.role, 'user')
  assert.match((event.data.content[0] as { text: string }).text, /hello/)
})

test('targetSessionId 延续：追加 open turn + user message，不新建会话', async () => {
  const stored = [{ type: 'turn/end', seq: 4, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }]
  const appended: unknown[] = []
  const persistence = {
    load: async () => ({ meta: {}, events: stored }),
    append: async (_id: unknown, events: unknown) => { appended.push(events) },
  }
  const ctx = makeCtx(undefined, persistence)

  const result = await transferToHarnessSession(ctx, { transcript, targetSessionId: 'session-existing' }, NO_DISTILL)

  assert.equal(result.sessionId, 'session-existing')
  assert.equal(result.attached, false)
  assert.equal(result.distilled, false)
  const events = appended[0] as Array<{ type: string; seq: number; surfaceOp?: string; data?: { turn?: number; step?: number } }>
  assert.equal(events.length, 3)
  assert.equal(events[0]!.type, 'turn/start')
  assert.equal(events[0]!.seq, 5)
  assert.equal(events[0]!.data?.turn, 2)
  assert.equal(events[1]!.type, 'step/start')
  assert.equal(events[1]!.seq, 6)
  assert.equal(events[1]!.data?.step, 1)
  assert.equal(events[2]!.type, 'user/message')
  assert.equal(events[2]!.seq, 7)
  assert.equal(events[2]!.surfaceOp, 'append')
})

test('targetSessionId 延续：无持久化后端时抛错', async () => {
  const ctx = makeCtx(undefined, undefined)
  await assert.rejects(
    transferToHarnessSession(ctx, { transcript, targetSessionId: 'session-x' }, NO_DISTILL),
    /持久化后端/,
  )
})

test('chunkTranscript 按字符预算分块且不拆分单条消息', () => {
  const msgs: WebChatMessage[] = [
    { id: 'a', role: 'user', content: 'aaaa', ts: 0 },
    { id: 'b', role: 'assistant', content: 'bbbb', ts: 0 },
    { id: 'c', role: 'user', content: 'cc', ts: 0 },
    { id: 'd', role: 'assistant', content: 'dd', ts: 0 },
  ]
  const chunks = chunkTranscript({ ...transcript, messages: msgs }, 10)
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0]!.map(m => m.id), ['a', 'b', 'c'])
  assert.deepEqual(chunks[1]!.map(m => m.id), ['d'])
})

test('chunkTranscript 超预算的单条消息独占一块', () => {
  const msgs: WebChatMessage[] = [
    { id: 'a', role: 'user', content: '短', ts: 0 },
    { id: 'big', role: 'assistant', content: 'x'.repeat(50), ts: 0 },
    { id: 'c', role: 'user', content: '尾', ts: 0 },
  ]
  const chunks = chunkTranscript({ ...transcript, messages: msgs }, 10)
  assert.deepEqual(chunks.map(chunk => chunk.map(m => m.id)), [['a'], ['big'], ['c']])
})

test('chunkTranscript 跳过未完成的流式回复', () => {
  const msgs: WebChatMessage[] = [
    { id: 'a', role: 'user', content: '问题', ts: 0 },
    { id: 's', role: 'assistant', content: '未完成的流式回复', ts: 0, streaming: true },
    { id: 'b', role: 'user', content: '继续', ts: 0 },
  ]
  const chunks = chunkTranscript({ ...transcript, messages: msgs }, 10)
  assert.deepEqual(chunks.flat().map(m => m.id), ['a', 'b'])
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
