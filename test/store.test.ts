/**
 * Unit tests for the transcript store's web-recovery import path (dedup by
 * title, active-chat selection) — the pure, testable half of web→local sync.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../src/store.ts'
import type { WebChatMessage } from '../src/protocol.ts'

function makeMessages(n: number): WebChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: `msg${i}`, ts: Date.now() }))
}

test('importTranscript 创建新 transcript 并置为 active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webchat-store-'))
  const store = new TranscriptStore({ dataDir: dir })
  const { chat, created } = store.importTranscript({ title: '网页会话 A', model: 'deepseek-chat', messages: makeMessages(2) })
  assert.equal(created, true)
  assert.equal(chat.title, '网页会话 A')
  assert.equal(chat.messages.length, 2)
  assert.equal(store.activeChat()?.id, chat.id)
  assert.deepEqual(store.titles(), ['网页会话 A'])
})

test('importTranscript 按标题去重（幂等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webchat-store-'))
  const store = new TranscriptStore({ dataDir: dir })
  const first = store.importTranscript({ title: '同一标题', model: 'deepseek-chat', messages: makeMessages(1) })
  const second = store.importTranscript({ title: '同一标题', model: 'deepseek-chat', messages: makeMessages(3) })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.chat.id, first.chat.id)
  assert.equal(store.list().length, 1)
})
