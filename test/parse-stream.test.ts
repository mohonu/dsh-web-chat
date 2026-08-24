/**
 * Unit tests for the SSE reply parser (parseStreamReply). The parser is the
 * most fragile piece of the plugin — it decodes DeepSeek's `/api/v0/chat/completion`
 * ops stream — so these fixtures pin every protocol shape the engine relies on:
 * snapshot, fragment append, content delta, search/TOOL_OPEN steps, citation
 * resolution, and malformed/empty streams.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStreamReply } from '../src/engine/engine.ts'

/** Build SSE body text from JSON payloads (the capture accumulates raw `data:` lines). */
function sse(...payloads: unknown[]): string {
  return payloads.map(payload => `data: ${JSON.stringify(payload)}`).join('\n')
}

test('simple RESPONSE flow: snapshot + content delta + FINISHED', () => {
  const raw = sse(
    { v: { response: { fragments: [{ type: 'RESPONSE', content: '你好' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '，世界' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  )
  const result = parseStreamReply(raw)
  assert.equal(result.markdown, '你好，世界')
  assert.equal(result.thinking, '')
  assert.equal(result.finished, true)
})

test('R1 reasoning is captured as THINK and wrapped in a details block', () => {
  const raw = sse(
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '让我想想' }] },
    { v: '这个问题……' },
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '答案是 42' }] },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  )
  const result = parseStreamReply(raw)
  assert.equal(result.thinking, '让我想想这个问题……')
  assert.match(result.markdown, /<details><summary>思考过程<\/summary>/)
  assert.match(result.markdown, /答案是 42/)
  assert.equal(result.finished, true)
})

test('search results and TOOL_OPEN steps are recorded, citations resolved', () => {
  const raw = sse(
    { p: 'response/fragments/-1/results', o: 'SET', v: [{ url: 'https://example.com/a' }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'TOOL_OPEN', id: 7, result: { title: 'A Page', url: 'https://example.com/a' } }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '结论' }] },
    { v: [{ p: 'content', o: 'APPEND', v: '[reference:1]' }, { p: 'references', o: 'SET', v: [{ type: 'TOOL_OPEN', id: 7 }] }] },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  )
  const result = parseStreamReply(raw)
  assert.match(result.markdown, /搜索到 1 个网页/)
  assert.match(result.markdown, /浏览 1 个页面/)
  assert.match(result.markdown, /- A Page/)
  assert.match(result.markdown, /结论\[citation:1\]/)
  assert.equal(result.finished, true)
})

test('TOOL_SEARCH references are dropped (no citation number)', () => {
  const raw = sse(
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '见' }] },
    { v: [{ p: 'content', o: 'APPEND', v: '[reference:1]' }, { p: 'references', o: 'SET', v: [{ type: 'TOOL_SEARCH' }] }] },
  )
  const result = parseStreamReply(raw)
  assert.doesNotMatch(result.markdown, /reference:/)
  assert.doesNotMatch(result.markdown, /citation:/)
})

test('snapshot replaces previously accumulated body', () => {
  const raw = sse(
    { v: { response: { fragments: [{ type: 'RESPONSE', content: 'first' }] } } },
    { v: { response: { fragments: [{ type: 'RESPONSE', content: 'second' }] } } },
  )
  const result = parseStreamReply(raw)
  assert.equal(result.markdown, 'second')
  assert.equal(result.finished, false)
})

test('no FINISHED leaves finished=false', () => {
  const raw = sse({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'partial' }] } } })
  assert.equal(parseStreamReply(raw).finished, false)
})

test('empty and malformed streams degrade to empty output', () => {
  assert.deepEqual(parseStreamReply(''), { markdown: '', thinking: '', finished: false })
  const malformed = 'data: not-json\ndata: {"v":"hi"}\nevent: done\ndata: {bad}\n'
  assert.equal(parseStreamReply(malformed).markdown, 'hi')
})
