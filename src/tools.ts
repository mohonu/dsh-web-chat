/**
 * Agent tools: the DSH-native counterpart of the web-chat panel. The harness
 * agent can chat through the DeepSeek web session (webchat_send), inspect
 * stored transcripts (webchat_status / webchat_import), and hand a web
 * conversation into a new harness session (webchat_transfer) — mirroring how
 * Codex's chatgpt mode lets the agent itself use the web subscription.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { DeepSeekWebEngine } from './engine/engine.ts'
import type { TranscriptStore } from './store.ts'
import { renderTranscriptMarkdown, transferToHarnessSession } from './transfer.ts'
import type { DistillConfig } from './transfer.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render the chat list compactly. */
function renderChats(store: TranscriptStore): string {
  const chats = store.list()
  if (chats.length === 0) return '还没有任何网页端对话记录'
  return chats.map(chat => {
    const messages = chat.messages.length
    const last = chat.messages.at(-1)
    const preview = last === undefined ? '' : ` · 最后: ${last.content.replace(/\s+/g, ' ').slice(0, 60)}`
    return `${chat.id} | ${chat.title} | ${chat.model} | ${messages} 条消息 | ${new Date(chat.updatedAt).toLocaleString()}${preview}`
  }).join('\n')
}

/** The engine-status tool. */
export function webChatStatusTool(engine: DeepSeekWebEngine, store: TranscriptStore) {
  return defineTool({
    name: 'webchat_status',
    description: 'Report the DeepSeek 网页端 (chat.deepseek.com) web-chat state: engine status, login state, active chat, and stored transcripts. Triggers: webchat, deepseek 网页端, 网页聊天. Use before webchat_send to confirm login.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value: { report?: string }) => text(value.report ?? ''),
    },
    async execute(): Promise<{ report: string }> {
      const status = await engine.status()
      const active = store.activeChat()
      const lines = [
        `engine: ${status.engine}${status.engineError !== undefined ? ` (${status.engineError})` : ''}`,
        `loggedIn: ${String(status.loggedIn)}`,
        `pageUrl: ${status.pageUrl ?? '-'}`,
        `deepThink: ${String(status.deepThink)}`,
        `search: ${String(status.search)}`,
        `busy: ${String(status.busy)}`,
        `activeChat: ${active === undefined ? '-' : `${active.id} (${active.title})`}`,
        `chats:\n${renderChats(store)}`,
      ]
      return { report: lines.join('\n') }
    },
  })
}

/** The send-via-web tool. */
export function webChatSendTool(engine: DeepSeekWebEngine) {
  return defineTool({
    name: 'webchat_send',
    description: 'Send one message through the DeepSeek 网页端 (chat.deepseek.com) using the web model — your web session, no API billing. The assistant reply streams until complete and returns as markdown. Requires the user to have logged into the web chat once (webchat_status → loggedIn true). Best for asking the web model to explain/design/review; do not use for file operations. Triggers: 网页端提问, deepseek web, chatgpt mode.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message to send to deepseek-chat on the web.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', required: true },
          error: { type: 'string' },
          partial: { type: 'boolean' },
        },
      },
      render: (_args, value: { reply?: string; error?: string; partial?: boolean }) => {
        const partial = value.partial === true
        return text([
          `webchat_send: 已通过 DeepSeek 网页端发送并收到回复${partial ? '（生成可能不完整）' : ''}`,
          value.error !== undefined ? `（注意：${value.error}）` : '',
          '',
          '--- 网页端回复 ---',
          (value.reply ?? '').trim() === '' ? '（空回复）' : (value.reply ?? '').trim(),
          '--- 回复结束 ---',
          '',
          '会话已保存，可用 webchat_transfer 将整段对话转移到 harness 会话。',
        ].join('\n'))
      },
    },
    async execute(args: { text?: string }): Promise<{ reply: string; error?: string; partial: boolean }> {
      const textValue = typeof args?.text === 'string' ? args.text.trim() : ''
      if (textValue === '') return { reply: '', error: '缺少 text 参数', partial: false }
      const result = await engine.send(textValue)
      return {
        reply: result.reply ?? '',
        error: result.error,
        partial: result.error !== undefined,
      }
    },
  })
}

/** The transcript import tool. */
export function webChatImportTool(store: TranscriptStore) {
  return defineTool({
    name: 'webchat_import',
    description: 'Import one stored DeepSeek 网页端 transcript as markdown so the agent can continue the discussion itself. Triggers: 读取网页对话, import webchat, 把网页聊天作为上下文. Use webchat_status to list chat ids first.',
    parameters: {
      chatId: { type: 'string', description: 'Transcript id (from webchat_status). Omit for the active chat.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transcript: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { transcript?: string; error?: string }) => {
        if (value.error !== undefined) return text(value.error)
        return text(value.transcript ?? '')
      },
    },
    async execute(args: { chatId?: string }): Promise<{ transcript: string; error?: string }> {
      const chat = typeof args?.chatId === 'string' ? store.getChat(args.chatId) : store.activeChat()
      if (chat === undefined) return { transcript: '', error: 'webchat_import: 找不到对话记录（用 webchat_status 查看列表）' }
      return { transcript: renderTranscriptMarkdown(chat) }
    },
  })
}

/** The transfer tool (closes over the host context so it can create sessions). */
export function webChatTransferTool(hostCtx: Context, store: TranscriptStore, distill: DistillConfig) {
  return defineTool({
    name: 'webchat_transfer',
    description: 'Transfer a stored DeepSeek 网页端 transcript into harness mode: distills the web conversation into an executable task brief (goal, established context, current state, next steps) and creates a NEW harness session whose first message is that brief (not the raw chat log). Returns the new session id. Triggers: 转移到 harness, 转成开发会话, transfer webchat.',
    parameters: {
      chatId: { type: 'string', description: 'Transcript id (from webchat_status). Omit for the active chat.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          distilled: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { sessionId?: string; distilled?: boolean; error?: string }) => {
        if (value.error !== undefined) return text(value.error)
        const note = value.distilled === true ? '（已蒸馏为任务简报）' : '（蒸馏不可用，已回退为原始对话记录）'
        return text(`webchat_transfer: 已创建新 harness 会话 ${value.sessionId ?? ''}${note}。请告知用户从侧边栏打开该会话继续开发。`)
      },
    },
    async execute(args: { chatId?: string }): Promise<{ sessionId: string; distilled: boolean; error?: string }> {
      const chat = typeof args?.chatId === 'string' ? store.getChat(args.chatId) : store.activeChat()
      if (chat === undefined) return { sessionId: '', distilled: false, error: 'webchat_transfer: 找不到对话记录（用 webchat_status 查看列表）' }
      try {
        const { sessionId, distilled } = await transferToHarnessSession(hostCtx, { transcript: chat }, distill)
        return { sessionId, distilled }
      } catch (error) {
        return { sessionId: '', distilled: false, error: `webchat_transfer: 创建会话失败 — ${String(error)}` }
      }
    },
  })
}
