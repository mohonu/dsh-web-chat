/**
 * Harness-mode transfer: turn a web-chat transcript into development context.
 *
 * This is the "Continue in Codex" / ChatGPT-mode analog, and like Codex it is
 * a CONTEXT HANDOFF rather than a raw replay: the exploration-phase web
 * conversation is distilled (via the harness LLM) into an executable task
 * brief — the execution-phase state representation the agent actually needs —
 * and that brief seeds a fresh harness session. The raw transcript is kept as
 * the fallback when distillation is unavailable.
 *
 * Two targets:
 *  - new harness session — a COLD persisted session seeded with the distilled
 *    brief (or raw transcript), so it shows up in the GUI list and resumes;
 *  - workspace file — the raw transcript rendered to markdown in the target
 *    project directory, so any agent can read it with file tools.
 *
 * Session creation writes directly through the session-persistence backend
 * (`sessionPersistence.create` + `append`), NOT `ctx.sessions.create()`:
 * the store's `create` produces a LIVE session owned by the calling fiber,
 * which the GUI then refuses to resume ("cannot prepare … while it is live").
 * A cold persisted session is exactly what the GUI's resume path expects.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { TransferMode, WebChatTranscript } from './protocol.ts'

/** Role label used in rendered transcripts. */
const ROLE_LABEL: Record<'user' | 'assistant', string> = { user: '用户', assistant: 'DeepSeek（网页端）' }

/** Remove the collapsible R1 reasoning block(s) from reply markdown. */
function stripThinking(markdown: string): string {
  return markdown
    .replace(/<details>\s*<summary>.*?<\/summary>[\s\S]*?<\/details>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Render one transcript to markdown for harness consumption. */
export function renderTranscriptMarkdown(transcript: WebChatTranscript, options?: { excludeThinking?: boolean }): string {
  const excludeThinking = options?.excludeThinking ?? false
  const lines: string[] = []
  lines.push(`# 网页端对话记录：${transcript.title}`)
  lines.push('')
  lines.push(`- 来源：DeepSeek 网页端（chat.deepseek.com）· 模型 ${transcript.model}`)
  lines.push(`- 开始时间：${new Date(transcript.createdAt).toLocaleString()}`)
  lines.push(`- 消息数：${transcript.messages.length}`)
  lines.push('')
  lines.push('> 以下内容由 dsh-webchat 插件从 DeepSeek 网页端会话导出。')
  lines.push('')
  for (const message of transcript.messages) {
    if (message.role === 'assistant' && message.streaming) continue
    const content = (excludeThinking ? stripThinking(message.content) : message.content).trim()
    lines.push(`## ${ROLE_LABEL[message.role]}`)
    lines.push('')
    lines.push(content === '' ? '（无内容）' : content)
    if (message.error !== undefined) {
      lines.push('')
      lines.push(`> ⚠️ 该条回复可能不完整：${message.error}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

/**
 * Framing that turns the distilled brief into established context for the
 * agent — the analog of Codex's "another model started to solve this problem
 * and produced a summary; use it to build on the work already done".
 */
export const HANDOFF_PREAMBLE = '这是一次从 DeepSeek 网页端会话（chat.deepseek.com）转来的上下文交接。下面的任务简报已把该对话提炼为可执行的任务上下文——把它当作既定目标与背景，直接在其基础上继续，不要复述。'

/**
 * The distillation directive. Delivered as the final user message after the
 * raw transcript so the model condenses the exploration phase into the
 * execution-phase state representation. Mirrors Codex's handoff and DSH's
 * compaction checkpoint structure, tuned for "web chat → coding task".
 */
const DISTILL_INSTRUCTION = [
  'You are distilling a web-chat conversation (a user exploring and planning with a DeepSeek web model) into an executable task brief for a coding agent that will resume this work in a FRESH session WITHOUT the raw conversation.',
  '',
  'Output EXACTLY the Markdown structure below — every section, in order, terse bullets, "(none)" for an empty section:',
  '',
  '## Objective',
  '- [the concrete goal/task to execute; quote the user\'s exact wording where it matters]',
  '',
  '## Established Context',
  '- [decisions, constraints, requirements, and facts already settled]',
  '',
  '## Current State',
  '- [what has been designed, decided, or produced so far]',
  '',
  '## Next Steps',
  '- [concrete ordered actions the coding agent should take]',
  '',
  '## Open Questions & Risks',
  '- [anything unresolved, uncertain, or risky]',
  '',
  'Rules:',
  '- Terse, concrete engineering prose. Preserve exact identifiers, paths, commands, error strings, code snippets, and numeric values.',
  '- Do not invent facts; mark uncertainty explicitly.',
  '- Do not mention this distillation request or the web-chat source.',
  '- Output only the brief.',
].join('\n')

/** Transfer distillation settings (resolved from the plugin config surface). */
export interface DistillConfig {
  /** When true (default), distill the transcript into a task brief via ctx.llm. */
  distill: boolean
  /** Provider route for the distillation call; empty = auto-detect. */
  provider: string
  /** Model id for the distillation call; empty = auto-detect. */
  model: string
}

/** A successful distillation result. */
export interface DistillResult {
  brief: string
  provider: string
  model: string
}

/** Pick a provider/model for the one-shot distillation call. */
async function resolveDistillTarget(llm: LlmRuntime, provider: string, model: string): Promise<{ provider: string; model: string } | undefined> {
  if (provider !== '' && model !== '') return { provider, model }
  const providers = llm.listProviders()
  if (providers.length === 0) return undefined
  const baseProvider = provider !== ''
    ? provider
    : (providers.find(entry => entry.id.toLowerCase().includes('deepseek')) ?? providers[0]).id
  if (model !== '') return { provider: baseProvider, model }
  const models = await llm.listModels(baseProvider)
  const picked = models.find(entry => entry.id.toLowerCase().includes('chat')) ?? models[0]
  return picked === undefined ? undefined : { provider: baseProvider, model: picked.id }
}

/**
 * Distill a web transcript into an executable task brief via the harness LLM.
 * Returns undefined (so callers fall back to the raw transcript) when the LLM
 * service, a provider/model, or a clean completion is unavailable.
 */
export async function distillTranscriptToBrief(ctx: Context, transcript: WebChatTranscript, config: DistillConfig): Promise<DistillResult | undefined> {
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (llm === undefined) return undefined
  const target = await resolveDistillTarget(llm, config.provider, config.model).catch(() => undefined)
  if (target === undefined) return undefined

  const instruction = `${DISTILL_INSTRUCTION}\n\n--- 网页对话记录 ---\n\n${renderTranscriptMarkdown(transcript, { excludeThinking: true })}`
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: instruction }],
        source: { kind: 'plugin', plugin: 'webchat' },
      })],
      maxTokens: 2_048,
      purpose: 'compaction',
    })) {
      assembler.push(chunk)
    }
  } catch {
    return undefined
  }
  const finish = assembler.finish
  if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') return undefined
  const brief = assembler.blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (brief === '') return undefined
  return { brief, provider: target.provider, model: target.model }
}

/** Build the seed user-message event carrying the handoff text. */
export function transcriptSeedEvent(markdown: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: 0,
    time: Date.now(),
    // Surface events must declare how they entered the ordered surface; a
    // seeded user prompt appends to the tail.
    surfaceOp: 'append',
    data: {
      id: randomUUID() as MessageId,
      role: 'user',
      content: [{ type: 'text', text: markdown }],
      source: { kind: 'plugin', plugin: 'webchat' },
    },
  }
}

/**
 * Sanitize a web-chat title into a safe single-line session title (the host
 * session-title service strips control characters and collapses whitespace;
 * mirror that lightly so a transferred title never overflows the fold).
 */
function normalizeSessionTitleText(text: string): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, 80).join('')
}

/**
 * Build the durable `session/title` event that pins the transferred session's
 * display name to the web chat's title. The `session/title` type is a
 * plugin-merged extension of `SessionEventMap` (from dsh-session-title), so it
 * is not in this package's compiled `SessionEvent` union — cast through
 * `unknown`. `source.kind: 'user'` pins the title against auto-regeneration.
 */
function transcriptTitleEvent(title: string, seq: number, time: number): SessionEvent {
  return {
    type: 'session/title',
    seq,
    time,
    data: {
      title: normalizeSessionTitleText(title),
      messageSeqs: [],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent
}

/** Validate/normalize a workspace directory (must be absolute). */
function normalizeCwd(cwd: string | undefined): string {
  const resolved = cwd === undefined || cwd === '' ? process.cwd() : cwd
  if (!resolved.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(resolved)) {
    throw new Error(`cwd 必须是绝对路径，收到: ${resolved}`)
  }
  return resolved
}

export interface TransferWorkspaceTarget {
  /** Stable workspace id (from the registry / GUI picker); wins over `path`. */
  workspaceId?: string
  /** Directory path to use as the session cwd (optionally resolves to a workspace). */
  path?: string
}

export interface TransferToSessionInput {
  transcript: WebChatTranscript
  cwd?: string
  /** Target workspace; when set, the session is grouped under it (attached). */
  workspace?: TransferWorkspaceTarget
}

/** Resolved transfer destination: the session cwd plus an optional owning workspace. */
export interface ResolvedTransferTarget {
  cwd: string
  workspace?: Workspace
}

/** The result of creating a transferred harness session. */
export interface TransferToSessionResult {
  sessionId: string
  distilled: boolean
  /** True when the session was attached to a workspace; false = ungrouped. */
  attached: boolean
  /** Workspace id the session landed in, when attached. */
  workspaceId?: string
}

/** Access the optional workspace registry without a hard service dependency. */
function workspaceRegistryOf(ctx: Context): WorkspaceRegistry | undefined {
  return ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
}

/**
 * Resolve the transfer destination. A `workspace.workspaceId` is validated
 * BEFORE the session is persisted so an unknown id fails fast instead of
 * leaving an orphan ungrouped session; `workspace.path` is realpath-canonicalized
 * (an existing directory) and opportunistically resolved to a workspace; with
 * no workspace the existing `cwd` behavior applies unchanged.
 */
async function resolveTransferTarget(ctx: Context, input: TransferToSessionInput): Promise<ResolvedTransferTarget> {
  const registry = workspaceRegistryOf(ctx)
  const target = input.workspace

  if (target?.workspaceId !== undefined && target.workspaceId !== '') {
    if (registry === undefined) {
      throw new Error(`无法归入工作区 ${target.workspaceId}：当前部署未挂载工作区服务`)
    }
    const workspace = registry.get(target.workspaceId as WorkspaceId)
    if (workspace === undefined) {
      throw new Error(`工作区 ${target.workspaceId} 不存在或已删除`)
    }
    return { cwd: workspace.path, workspace }
  }

  if (target?.path !== undefined && target.path !== '') {
    let cwd: string
    try {
      cwd = await realpath(target.path)
    } catch {
      throw new Error(`工作区路径不可用（不存在或不是目录）：${target.path}`)
    }
    const workspace = registry === undefined ? undefined : await registry.resolveByPath(cwd).catch(() => undefined)
    return { cwd, workspace }
  }

  return { cwd: normalizeCwd(input.cwd) }
}

/**
 * Create a new COLD harness session seeded with a distilled task brief (or the
 * raw transcript when the user chooses 'raw' / distillation is unavailable),
 * written straight through the session-persistence backend so the GUI lists it
 * and can resume it later (no live-store ownership). When `input.workspace`
 * names a registered workspace, the session's cwd is set to that workspace's
 * canonical path and the session is attached to the workspace's account, so
 * the GUI groups it under that workspace instead of "ungrouped".
 *
 * `mode` is the user's explicit choice; when undefined the plugin config
 * default (`transferDistill`) applies.
 */
export async function transferToHarnessSession(ctx: Context, input: TransferToSessionInput, config: DistillConfig, mode?: TransferMode): Promise<TransferToSessionResult> {
  const target = await resolveTransferTarget(ctx, input)
  const rawMarkdown = renderTranscriptMarkdown(input.transcript, { excludeThinking: true })

  const shouldDistill = mode === 'distill' ? true : mode === 'raw' ? false : config.distill
  let seedMarkdown = `${HANDOFF_PREAMBLE}\n\n${rawMarkdown}`
  let distilled = false
  if (shouldDistill) {
    const result = await distillTranscriptToBrief(ctx, input.transcript, config)
    if (result !== undefined) {
      seedMarkdown = `${HANDOFF_PREAMBLE}\n\n${result.brief}\n\n> （已由 ${result.provider}/${result.model} 从网页对话蒸馏生成）`
      distilled = true
    }
  }

  const id = SessionId(`session-${randomUUID()}`)
  const createdAt = Date.now()
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt, cwd: target.cwd, delegationDepth: 0 }

  // Seed the handoff message, then pin the display name to the web chat's
  // title (seq 1, immediately after the seed) so the GUI list shows the chat
  // title instead of falling back to the cwd basename or the raw session id.
  const seedEvent = transcriptSeedEvent(seedMarkdown)
  const title = normalizeSessionTitleText(input.transcript.title)
  const events: SessionEvent[] = [seedEvent]
  if (title !== '') events.push(transcriptTitleEvent(title, seedEvent.seq + 1, seedEvent.time))

  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    // Cold path: register metadata, then persist the seed + title events.
    // `append`'s contiguous-seq contract starts at 0 for a fresh session,
    // matching the seed event's seq. `session/end-seed` is re-added on resume,
    // so it is not written here.
    await persistence.create(header)
    await persistence.append(id, events)
  } else {
    // No persistence backend mounted (the deployment has no resume path).
    ctx.sessions.create(id, { meta: { cwd: target.cwd }, seed: events })
  }

  let attached = false
  if (target.workspace !== undefined) {
    try {
      await target.workspace.attachSession(id)
      attached = true
    } catch {
      // Non-fatal: the session is already persisted; it simply stays ungrouped.
      attached = false
    }
  }
  const workspaceId = attached && target.workspace !== undefined ? target.workspace.id : undefined
  return { sessionId: id, distilled, attached, workspaceId }
}

export interface ExportTranscriptInput {
  transcript: WebChatTranscript
  cwd?: string
}

/** Write the transcript markdown into the target directory; returns the path. */
export function exportTranscriptFile(input: ExportTranscriptInput): { filePath: string } {
  const cwd = normalizeCwd(input.cwd)
  const slug = input.transcript.title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'webchat'
  const fileName = `webchat-${slug}-${input.transcript.id.slice(-6)}.md`
  const filePath = join(cwd, fileName)
  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, renderTranscriptMarkdown(input.transcript), 'utf8')
  return { filePath: basename(filePath) }
}
