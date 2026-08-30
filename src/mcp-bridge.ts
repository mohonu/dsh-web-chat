/**
 * Bridge between dsh-webchat and the DSH native tool registry.
 *
 * dsh-mcp-client registers external MCP tools into ctx.tools as:
 *   mcp__<server>__<tool>
 *
 * We deliberately expose ONLY tools with the mcp__ prefix.
 */

import type { Context } from '@deepseek-ai/cordis'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallRequest {
  tool: string
  arguments?: Record<string, unknown>
}

export interface McpCallResult {
  content?: unknown
  isError?: boolean
  [key: string]: unknown
}

type RegisteredTool = {
  name?: string
  description?: string
  parameters?: unknown
  inputSchema?: unknown
  execute?: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> | unknown
}

type ToolsRegistry = {
  list?: () => unknown
  get?: (name: string) => RegisteredTool | undefined
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

function getRegistry(ctx: Context): ToolsRegistry {
  return (ctx as unknown as { tools: ToolsRegistry }).tools
}

function normalizeTool(tool: RegisteredTool): McpToolInfo {
  return {
    name: tool.name ?? '',
    description: tool.description,
    inputSchema: tool.parameters ?? tool.inputSchema
  }
}

export class WebChatMcpBridge {
  constructor(private readonly ctx: Context) {}

  listTools(): McpToolInfo[] {
    const tools = getRegistry(this.ctx)

    if (typeof tools.list !== 'function') {
      return []
    }

    const result = tools.list()

    if (!Array.isArray(result)) {
      return []
    }

    return result
      .filter((tool): tool is RegisteredTool => {
        return (
          typeof tool === 'object' &&
          tool !== null &&
          typeof tool.name === 'string' &&
          tool.name.startsWith('mcp__')
        )
      })
      .map(normalizeTool)
  }

  async callTool(request: McpCallRequest): Promise<McpCallResult> {
    if (!request.tool.startsWith('mcp__')) {
      throw new Error(`Refusing non-MCP tool: ${request.tool}`)
    }

    const tools = getRegistry(this.ctx)

    if (typeof tools.get === 'function') {
      const tool = tools.get(request.tool)

      if (!tool) {
        throw new Error(`MCP tool not found: ${request.tool}`)
      }

      if (typeof tool.execute !== 'function') {
        throw new Error(`MCP tool is not executable: ${request.tool}`)
      }

      const result = await tool.execute(request.arguments ?? {})

      return normalizeResult(result)
    }

    if (typeof tools.execute === 'function') {
      const result = await tools.execute(
        request.tool,
        request.arguments ?? {}
      )

      return normalizeResult(result)
    }

    throw new Error('DSH tool registry does not expose an executable API')
  }
}

function normalizeResult(result: unknown): McpCallResult {
  if (
    typeof result === 'object' &&
    result !== null
  ) {
    return result as McpCallResult
  }

  return {
    content: result
  }
}
