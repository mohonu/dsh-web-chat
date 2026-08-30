/**
 * dsh-webchat — host half. Mounts the DeepSeek web engine (a real browser at
 * chat.deepseek.com driven through its own page, persistent login profile),
 * the /api/dsh-webchat route family, the agent tools (webchat_status,
 * webchat_send, webchat_import, webchat_transfer), the harness transfer
 * (seed a new session with a web transcript) and a system-prompt
 * announcement. The browser half (./client) renders the chat panel. All
 * transport rides the official NPM SDK packages — no dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { DeepSeekWebEngine } from './engine/engine.ts'
import { makeRoutes } from './routes.ts'
import { TranscriptStore } from './store.ts'
import { webChatImportTool, webChatRecoverTool, webChatSendTool, webChatStatusTool, webChatTransferTool } from './tools.ts'
import type { WorkspaceRef } from './tools.ts'
import type { DistillConfig } from './transfer.ts'
import { WebChatMcpBridge } from './mcp-bridge.ts'
import { McpOrchestrator } from './mcp-orchestrator.ts'

/** Stable cordis plugin name. */
export const name = 'webchat'

/** Services required before the web-chat surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'sessions']

/**
 * Settings namespace of the web-chat capability — the section the web
 * settings surface edits. Spelled here rather than imported: the browser half
 * spells the same value and must not depend on a Host package.
 */
export const WEBCHAT_SETTINGS_NAMESPACE = settingsNamespace('dsh-webchat')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /** Browser channel hint ('chrome' | 'msedge' | 'chromium' | 'auto'). */
  browserChannel?: string
  /** Explicit browser executable path. */
  browserExecutablePath?: string
  /** Proxy mode: 'direct' | 'system' | 'http://host:port'. */
  browserProxy?: string
  /**
   * Run the chat browser headless (invisible). Default true: only the one-time
   * login window is visible, and it auto-closes once logged in. Set false to
   * keep a visible browser window during chatting too.
   */
  browserHeadless?: boolean
  /** Max ms to wait for a web reply. */
  replyTimeoutMs?: number
  /** Data directory override (tests). */
  dataDir?: string
  /** When true (default), distill the transcript into an executable task brief before transfer. */
  transferDistill?: boolean
  /** Provider route for the transfer distillation call (empty = auto-detect). */
  transferProvider?: string
  /** Model id for the transfer distillation call (empty = auto-detect). */
  transferModel?: string
  /** Output-token cap for the final distillation brief (default 4096). */
  transferMaxTokens?: number
  /** Output-token cap per chunk summary in long-conversation map-reduce (default 1024). */
  transferChunkTokens?: number
  /** When true (default), allow the web model to invoke MCP tools registered in DSH. */
  mcpEnabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
  browserChannel: z.string().default('auto'),
  browserExecutablePath: z.string().default(''),
  browserProxy: z.string().default('direct'),
  browserHeadless: z.boolean().default(true),
  replyTimeoutMs: z.number().default(180_000),
  dataDir: z.string().default(''),
  transferDistill: z.boolean().default(true),
  transferProvider: z.string().default(''),
  transferModel: z.string().default(''),
  transferMaxTokens: z.number().default(4096),
  transferChunkTokens: z.number().default(1024),
  mcpEnabled: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 155

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const WEBCHAT_GUIDANCE = '\u672c\u673a\u5df2\u5b89\u88c5 dsh-webchat \u63d2\u4ef6\uff08Codex ChatGPT \u6a21\u5f0f \u00b7 DeepSeek \u7f51\u9875\u7aef\u804a\u5929\uff09\uff1a\u4fa7\u8fb9\u680f\u300c\u7f51\u9875\u804a\u5929\u300d\u5165\u53e3\uff1b\u901a\u8fc7\u771f\u5b9e\u6d4f\u89c8\u5668\u9a71\u52a8 chat.deepseek.com\uff08DeepSeek \u7f51\u9875\u6a21\u578b\uff0c\u6df1\u5ea6\u601d\u8003/\u667a\u80fd\u641c\u7d22\u5f00\u5173\uff0c\u7f51\u9875\u767b\u5f55\u4f1a\u8bdd\uff0c\u65e0\u9700 API \u989d\u5ea6\uff09\u3002\u80fd\u529b\uff1awebchat_status \u67e5\u770b\u767b\u5f55/\u4f1a\u8bdd\u72b6\u6001\u3001webchat_send \u901a\u8fc7\u7f51\u9875\u7aef\u53d1\u9001\u6d88\u606f\u5e76\u6d41\u5f0f\u83b7\u53d6\u56de\u590d\uff08\u53ef\u9644\u5e26\u672c\u5730\u56fe\u7247\u8def\u5f84\u505a\u591a\u6a21\u6001\u63d0\u95ee\uff1b\u5f53 DSH \u4e2d\u6ce8\u518c\u4e86 MCP \u5de5\u5177\u65f6\uff0c\u7f51\u9875\u7aef\u6a21\u578b\u53ef\u81ea\u52a8\u8c03\u7528\u8fd9\u4e9b\u5de5\u5177\u83b7\u53d6\u5b9e\u65f6\u6570\u636e\uff09\u3001webchat_recover \u628a\u7f51\u9875\u7aef\u5df2\u6709\u4f1a\u8bdd\u540c\u6b65/\u6062\u590d\u5230\u672c\u5730\u3001webchat_import \u628a\u5b58\u50a8\u7684\u7f51\u9875\u5bf9\u8bdd\u5bfc\u5165\u4e3a markdown \u4e0a\u4e0b\u6587\u3001webchat_transfer \u628a\u7f51\u9875\u5bf9\u8bdd\u84b8\u998f\u6210\u53ef\u6267\u884c\u4efb\u52a1\u7b80\u62a5\u5e76\u521b\u5efa\u65b0 harness \u4f1a\u8bdd\uff08\u9996\u6761\u6d88\u606f\u5373\u4efb\u52a1\u7b80\u62a5\uff0c\u800c\u975e\u539f\u59cb\u804a\u5929\u8bb0\u5f55\uff09\uff0c\u6216\u7ecf targetSessionId \u628a\u7b80\u62a5\u4f5c\u4e3a\u65b0\u6d88\u606f\u8ffd\u52a0\u5230\u5df2\u6709\u4f1a\u8bdd\u5ef6\u7eed\u540c\u4e00\u4efb\u52a1\uff1bGUI \u9762\u677f\u53ef\u5c06\u5bf9\u8bdd\u968f\u65f6\u5bfc\u51fa\u4e3a\u5de5\u4f5c\u533a\u6587\u4ef6\u6216\u8f6c\u5165 harness \u4f1a\u8bdd\u3002\u9650\u5236\uff1a\u9996\u6b21\u4f7f\u7528\u9700\u7528\u6237\u5728\u5f39\u51fa\u7684\u6d4f\u89c8\u5668\u7a97\u53e3\u5b8c\u6210 DeepSeek \u7f51\u9875\u767b\u5f55\uff1b\u7f51\u9875\u7aef\u53d7 DeepSeek \u5b98\u65b9\u98ce\u63a7\uff0c\u64cd\u4f5c\u5931\u8d25\u6216\u9875\u9762\u6539\u7248\u65f6\u8fd4\u56de\u9519\u8bef\u800c\u975e\u5d29\u6e83\uff1b\u9762\u677f\u63d0\u4f9b\u300c\u6df1\u5ea6\u601d\u8003\uff08R1\uff09\u300d\u4e0e\u300c\u667a\u80fd\u641c\u7d22\u300d\u5f00\u5173\uff08\u7f51\u9875\u7aef\u65e0\u6a21\u578b\u9009\u62e9\u5668\uff09\u3002\u7528\u6237\u63d0\u5230\u300c\u7f51\u9875\u804a\u5929 / \u7f51\u9875\u7aef / ChatGPT \u6a21\u5f0f / deepseek web / \u8f6c\u79fb\u5230 harness\u300d\u65f6\u5373\u6307\u672c\u63d2\u4ef6\uff0c\u8bf7\u636e\u6b64\u534f\u4f5c\u3002'

/** Convert resolved config to engine config. */
function engineConfigOf(resolve: () => Config): ConstructorParameters<typeof DeepSeekWebEngine>[1] {
  const value = resolve()
  const dataDir = value.dataDir?.trim() ?? ''
  return {
    dataDir: dataDir !== '' ? dataDir : defaultDataDirOf(),
    channel: value.browserChannel === 'auto' ? undefined : (value.browserChannel || undefined),
    executablePath: value.browserExecutablePath !== '' ? value.browserExecutablePath : undefined,
    proxy: value.browserProxy,
    headless: value.browserHeadless,
    replyTimeoutMs: value.replyTimeoutMs,
  }
}

/** Default plugin data dir (mirrors store.defaultDataDir). */
function defaultDataDirOf(): string {
  const home = process.env.DSH_HOME ?? process.env.HOME ?? '.'
  return `${home}/.dsh/dsh-webchat`
}

/**
 * Mount the engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
    enabled: current().enabled ?? true,
    browserChannel: current().browserChannel ?? 'auto',
    browserExecutablePath: current().browserExecutablePath ?? '',
    browserProxy: current().browserProxy ?? 'direct',
    browserHeadless: current().browserHeadless ?? true,
    replyTimeoutMs: current().replyTimeoutMs ?? 180_000,
    dataDir: current().dataDir ?? '',
    transferDistill: current().transferDistill ?? true,
    transferProvider: current().transferProvider ?? '',
    transferModel: current().transferModel ?? '',
    transferMaxTokens: current().transferMaxTokens ?? 4_096,
    transferChunkTokens: current().transferChunkTokens ?? 1_024,
    mcpEnabled: current().mcpEnabled ?? true,
  })

  const distillConfigOf = (value: Config): DistillConfig => ({
    distill: value.transferDistill ?? true,
    provider: (value.transferProvider ?? '').trim(),
    model: (value.transferModel ?? '').trim(),
    maxTokens: value.transferMaxTokens ?? 4_096,
    chunkTokens: value.transferChunkTokens ?? 1_024,
  })

  const store = new TranscriptStore({ dataDir: resolve().dataDir !== '' ? resolve().dataDir : undefined })
  const engine = new DeepSeekWebEngine(store, engineConfigOf(resolve))
  ctx.effect(() => () => {
    void engine.disposeBrowser()
  }, 'dsh-webchat: engine')

  const mcpBridge = new WebChatMcpBridge(ctx)
  const mcpOrchestrator = new McpOrchestrator(engine, mcpBridge, 8, resolve().mcpEnabled)

  const routes = makeRoutes({ ctx, engine, store, distill: distillConfigOf(resolve()), mcpBridge })
  const listWorkspaces = (): WorkspaceRef[] | undefined => {
    const registry = ctx.get('workspaceRegistry') as { list(): Array<{ id: string; path: string; title: string }> } | undefined
    if (registry === undefined) return undefined
    return registry.list().map(ws => ({ id: ws.id, path: ws.path, title: ws.title }))
  }

  const tools = [
    webChatStatusTool(engine, store, listWorkspaces, mcpBridge),
    webChatSendTool(engine, mcpOrchestrator),
    webChatRecoverTool(engine),
    webChatImportTool(store),
    webChatTransferTool(ctx, store, distillConfigOf(resolve())),
  ]

  let disposeSection: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined

  // Register (or drop) every surface to match the current source. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw.
  const sync = (): void => {
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-webchat',
        order: SECTION_ORDER,
        text: WEBCHAT_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-webchat: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-webchat: tools',
    )
  }

  installSettingsSection(ctx, WEBCHAT_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}