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
import type { WebChatErrorCode } from './protocol.ts'
import type { WebChatMcpBridge } from './mcp-bridge.ts'
import type { McpOrchestrator } from './mcp-orchestrator.ts'

/** Actionable hint for a structured engine error code (surfaced to the agent). */
function errorCodeHint(code: WebChatErrorCode | undefined): string {
  switch (code) {
    case 'NEED_LOGIN': return '\u9700\u8981\u5148\u767b\u5f55\uff1a\u8bf7\u5728\u63d2\u4ef6\u9762\u677f\u70b9\u51fb\u300c\u6253\u5f00\u767b\u5f55\u7a97\u53e3\u300d\u5b8c\u6210 DeepSeek \u7f51\u9875\u767b\u5f55\u3002'
    case 'PAGE_CHANGED': return '\u9875\u9762/\u534f\u8bae\u7591\u4f3c\u6539\u7248\uff1a\u8bf7\u5347\u7ea7 dsh-webchat \u63d2\u4ef6\u3002'
    case 'TIMEOUT': return '\u751f\u6210\u8d85\u65f6\uff1a\u53ef\u7a0d\u540e\u91cd\u8bd5\u3002'
    case 'NETWORK': return '\u7f51\u7edc/\u6d4f\u89c8\u5668\u9519\u8bef\uff1a\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u6d4f\u89c8\u5668\u662f\u5426\u53ef\u7528\u3002'
    default: return ''
  }
}

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Minimal workspace projection surfaced to the agent (id/path/title only). */
export interface WorkspaceRef {
  id: string
  path: string
  title: string
}

/** Render the chat list compactly. */
function renderChats(store: TranscriptStore): string {
  const chats = store.list()
  if (chats.length === 0) return '\u8fd8\u6ca1\u6709\u4efb\u4f55\u7f51\u9875\u7aef\u5bf9\u8bdd\u8bb0\u5f55'
  return chats.map(chat => {
    const messages = chat.messages.length
    const last = chat.messages.at(-1)
    const preview = last === undefined ? '' : ` \u00b7 \u6700\u540e: ${last.content.replace(/\s+/g, ' ').slice(0, 60)}`
    return `${chat.id} | ${chat.title} | ${chat.model} | ${messages} \u6761\u6d88\u606f | ${new Date(chat.updatedAt).toLocaleString()}${preview}`
  }).join('\n')
}

/** The engine-status tool. */
export function webChatStatusTool(engine: DeepSeekWebEngine, store: TranscriptStore, listWorkspaces?: () => WorkspaceRef[] | undefined, mcpBridge?: WebChatMcpBridge) {
  return defineTool({
    name: 'webchat_status',
    description: 'Report the DeepSeek \u7f51\u9875\u7aef (chat.deepseek.com) web-chat state: engine status, login state, active chat, stored transcripts, and the harness workspaces available as webchat_transfer targets. Triggers: webchat, deepseek \u7f51\u9875\u7aef, \u7f51\u9875\u804a\u5929. Use before webchat_send to confirm login.',
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
      const web = await engine.listWebConversations().catch(() => [] as Array<{ title: string }>)
      if (web.length > 0) {
        const localTitles = new Set(store.list().map(chat => chat.title))
        const missing = web.filter(item => !localTitles.has(item.title)).map(item => item.title)
        lines.push(`webChats:\n${web.map(item => `  - ${item.title}`).join('\n')}`)
        if (missing.length > 0) lines.push(`webChatsNotImported (use webchat_recover):\n${missing.map(title => `  - ${title}`).join('\n')}`)
      }
      const workspaces = listWorkspaces?.()
      if (workspaces !== undefined) {
        lines.push('workspaces:')
        if (workspaces.length === 0) lines.push('  (none)')
        else for (const ws of workspaces) lines.push(`  ${ws.id} | ${ws.title} | ${ws.path}`)
      }
      if (mcpBridge !== undefined) {
        const mcpTools = mcpBridge.listTools()
        if (mcpTools.length > 0) {
          lines.push(`mcpTools: ${mcpTools.map(t => t.name).join(', ')}`)
        } else {
          lines.push('mcpTools: (none)')
        }
      }
      return { report: lines.join('\n') }
    },
  })
}

/** The send-via-web tool. */
export function webChatSendTool(engine: DeepSeekWebEngine, mcp?: McpOrchestrator) {
  return defineTool({
    name: 'webchat_send',
    description: 'Send one message through the DeepSeek \u7f51\u9875\u7aef (chat.deepseek.com) using the web model \u2014 your web session, no API billing. The assistant reply streams until complete and returns as markdown. Optionally attach local image files (absolute paths) for multimodal prompts. Requires the user to have logged into the web chat once (webchat_status \u2192 loggedIn true). Best for asking the web model to explain/design/review; do not use for file operations. Triggers: \u7f51\u9875\u7aef\u63d0\u95ee, deepseek web, chatgpt mode.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message to send to deepseek-chat on the web.' },
      images: { type: 'array', items: { type: 'string' }, description: 'Optional local absolute paths of image files to attach (multimodal prompt).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', required: true },
          error: { type: 'string' },
          code: { type: 'string' },
          partial: { type: 'boolean' },
        },
      },
      render: (_args, value: { reply?: string; error?: string; code?: string; partial?: boolean }) => {
        const partial = value.partial === true
        const hint = errorCodeHint(value.code as WebChatErrorCode | undefined)
        return text([
          `webchat_send: \u5df2\u901a\u8fc7 DeepSeek \u7f51\u9875\u7aef\u53d1\u9001\u5e76\u6536\u5230\u56de\u590d${partial ? '\uff08\u751f\u6210\u53ef\u80fd\u4e0d\u5b8c\u6574\uff09' : ''}`,
          value.error !== undefined ? `\uff08\u6ce8\u610f\uff1a${value.error}\uff09` : '',
          hint !== '' ? `\uff08${hint}\uff09` : '',
          '',
          '--- \u7f51\u9875\u7aef\u56de\u590d ---',
          (value.reply ?? '').trim() === '' ? '\uff08\u7a7a\u56de\u590d\uff09' : (value.reply ?? '').trim(),
          '--- \u56de\u590d\u7ed3\u675f ---',
          '',
          '\u4f1a\u8bdd\u5df2\u4fdd\u5b58\uff0c\u53ef\u7528 webchat_transfer \u5c06\u6574\u6bb5\u5bf9\u8bdd\u8f6c\u79fb\u5230 harness \u4f1a\u8bdd\u3002',
        ].join('\n'))
      },
    },
    async execute(args: { text?: string; images?: unknown }): Promise<{ reply: string; error?: string; code?: string; partial: boolean }> {
      const textValue = typeof args?.text === 'string' ? args.text.trim() : ''
      if (textValue === '') return { reply: '', error: '\u7f3a\u5c11 text \u53c2\u6570', partial: false }
      const images = Array.isArray(args?.images)
        ? args.images.filter(value => typeof value === 'string').map(value => value as string)
        : undefined
      // wait=true so the tool returns the completed reply (the GUI path is fire-and-forget).
      const sender = mcp ?? engine
      const result = await sender.send(textValue, true, images)
      return {
        reply: result.reply ?? '',
        error: result.error,
        code: result.code,
        partial: result.error !== undefined,
      }
    },
  })
}

/** The web-conversation recover tool (sync web sidebar \u2192 local store). */
export function webChatRecoverTool(engine: DeepSeekWebEngine) {
  return defineTool({
    name: 'webchat_recover',
    description: 'Recover a DeepSeek \u7f51\u9875\u7aef conversation into the local store so it can be imported/transferred. With no title, lists the web-side conversations. Triggers: \u540c\u6b65\u7f51\u9875\u4f1a\u8bdd, \u6062\u590d\u7f51\u9875\u5bf9\u8bdd, sync webchat.',
    parameters: {
      title: { type: 'string', description: 'Conversation title (from the web sidebar or webchat_status webChats list). Omit to list web conversations.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
      render: (_args, value: { report?: string }) => text(value.report ?? ''),
    },
    async execute(args: { title?: string }): Promise<{ report: string }> {
      if (typeof args?.title === 'string' && args.title.trim() !== '') {
        const result = await engine.recoverWebConversation(args.title.trim())
        if (!result.ok) return { report: `webchat_recover: \u6062\u590d\u5931\u8d25 \u2014 ${result.error ?? ''}` }
        const dedup = result.created === false ? '\uff08\u672c\u5730\u5df2\u5b58\u5728\uff0c\u672a\u91cd\u590d\u5bfc\u5165\uff09' : ''
        return { report: `webchat_recover: \u5df2\u6062\u590d\u300c${result.title ?? ''}\u300d\u4e3a\u672c\u5730\u5bf9\u8bdd ${result.chatId ?? ''}${dedup}\u3002\u53ef\u7528 webchat_transfer \u8f6c\u79fb\u3002` }
      }
      const web = await engine.listWebConversations().catch(() => [] as Array<{ title: string }>)
      if (web.length === 0) return { report: 'webchat_recover: \u672a\u5728\u7f51\u9875\u7aef\u8bfb\u5230\u4f1a\u8bdd\uff08\u53ef\u80fd\u672a\u767b\u5f55\u6216\u9875\u9762\u5df2\u6539\u7248\uff09' }
      return { report: web.map(item => `- ${item.title}`).join('\n') }
    },
  })
}

/** The transcript import tool. */
export function webChatImportTool(store: TranscriptStore) {
  return defineTool({
    name: 'webchat_import',
    description: 'Import one stored DeepSeek \u7f51\u9875\u7aef transcript as markdown so the agent can continue the discussion itself. Triggers: \u8bfb\u53d6\u7f51\u9875\u5bf9\u8bdd, import webchat, \u628a\u7f51\u9875\u804a\u5929\u4f5c\u4e3a\u4e0a\u4e0b\u6587. Use webchat_status to list chat ids first.',
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
      if (chat === undefined) return { transcript: '', error: 'webchat_import: \u627e\u4e0d\u5230\u5bf9\u8bdd\u8bb0\u5f55\uff08\u7528 webchat_status \u67e5\u770b\u5217\u8868\uff09' }
      return { transcript: renderTranscriptMarkdown(chat) }
    },
  })
}

/** The transfer tool (closes over the host context so it can create sessions). */
export function webChatTransferTool(hostCtx: Context, store: TranscriptStore, distill: DistillConfig) {
  return defineTool({
    name: 'webchat_transfer',
    description: 'Transfer a stored DeepSeek \u7f51\u9875\u7aef transcript into harness mode: distills the web conversation into an executable task brief (goal, established context, current state, next steps) and creates a NEW harness session whose first message is that brief (not the raw chat log), OR appends it as a fresh user message to an EXISTING session via targetSessionId (continue the same task). Optionally target a workspace (workspaceId from webchat_status workspaces list) so the new session is grouped under it. Returns the (new or target) session id. Triggers: \u8f6c\u79fb\u5230 harness, \u8f6c\u6210\u5f00\u53d1\u4f1a\u8bdd, transfer webchat.',
    parameters: {
      chatId: { type: 'string', description: 'Transcript id (from webchat_status). Omit for the active chat.' },
      targetSessionId: { type: 'string', description: 'Optional existing harness session id to CONTINUE (append the brief as a new user message) instead of creating a new session. Omit to create a new session.' },
      workspaceId: { type: 'string', description: 'Optional target workspace id (from the workspaces list in webchat_status). Omit to leave the new session ungrouped. Ignored when targetSessionId is given.' },
      cwd: { type: 'string', description: 'Optional absolute working directory for the new session; ignored when workspaceId or targetSessionId is given.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          distilled: { type: 'boolean' },
          attached: { type: 'boolean' },
          continued: { type: 'boolean' },
          workspaceId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { sessionId?: string; distilled?: boolean; attached?: boolean; continued?: boolean; workspaceId?: string; error?: string }) => {
        if (value.error !== undefined) return text(value.error)
        const note = value.distilled === true ? '\uff08\u5df2\u84b8\u998f\u4e3a\u4efb\u52a1\u7b80\u62a5\uff09' : '\uff08\u84b8\u998f\u4e0d\u53ef\u7528\uff0c\u5df2\u56de\u9000\u4e3a\u539f\u59cb\u5bf9\u8bdd\u8bb0\u5f55\uff09'
        if (value.continued === true) {
          return text(`webchat_transfer: \u5df2\u628a\u7f51\u9875\u5bf9\u8bdd\u4f5c\u4e3a\u65b0\u7684\u7528\u6237\u6d88\u606f\u5ef6\u7eed\u5230 harness \u4f1a\u8bdd ${value.sessionId ?? ''}${note}\u3002\u8bf7\u544a\u77e5\u7528\u6237\u6253\u5f00\u8be5\u4f1a\u8bdd\u7ee7\u7eed\u5f00\u53d1\u3002`)
        }
        const where = value.workspaceId !== undefined ? `\u5df2\u5f52\u5165\u5de5\u4f5c\u533a ${value.workspaceId}` : '\u672a\u5206\u7ec4'
        return text(`webchat_transfer: \u5df2\u521b\u5efa\u65b0 harness \u4f1a\u8bdd ${value.sessionId ?? ''}${note}\uff08${where}\uff09\u3002\u8bf7\u544a\u77e5\u7528\u6237\u4ece\u4fa7\u8fb9\u680f\u6253\u5f00\u8be5\u4f1a\u8bdd\u7ee7\u7eed\u5f00\u53d1\u3002`)
      },
    },
    async execute(args: { chatId?: string; targetSessionId?: string; workspaceId?: string; cwd?: string }): Promise<{ sessionId: string; distilled: boolean; attached: boolean; continued?: boolean; workspaceId?: string; error?: string }> {
      const chat = typeof args?.chatId === 'string' ? store.getChat(args.chatId) : store.activeChat()
      if (chat === undefined) return { sessionId: '', distilled: false, attached: false, error: 'webchat_transfer: \u627e\u4e0d\u5230\u5bf9\u8bdd\u8bb0\u5f55\uff08\u7528 webchat_status \u67e5\u770b\u5217\u8868\uff09' }
      const targetSessionId = typeof args?.targetSessionId === 'string' && args.targetSessionId !== '' ? args.targetSessionId : undefined
      const workspace = targetSessionId === undefined && typeof args?.workspaceId === 'string' && args.workspaceId !== '' ? { workspaceId: args.workspaceId } : undefined
      try {
        const { sessionId, distilled, attached, workspaceId } = await transferToHarnessSession(hostCtx, { transcript: chat, cwd: args?.cwd, workspace, targetSessionId }, distill)
        return { sessionId, distilled, attached, continued: targetSessionId !== undefined, workspaceId }
      } catch (error) {
        return { sessionId: '', distilled: false, attached: false, continued: targetSessionId !== undefined, error: `webchat_transfer: \u8f6c\u79fb\u5931\u8d25 \u2014 ${String(error)}` }
      }
    },
  })
}