/**
 * MCP call detection and prompt building for the DeepSeek web-chat protocol.
 *
 * DeepSeek outputs tool calls wrapped in <dsh_mcp_call> tags. This module
 * extracts them, validates them, and builds the prompt prefix that teaches
 * DeepSeek which tools are available and how to call them.
 */

import type { McpToolInfo, McpCallResult } from './mcp-bridge.ts'

export interface ParsedMcpCall {
  tool: string
  arguments: Record<string, unknown>
}

const MCP_CALL_RE =
  /<dsh_mcp_call>\s*([\s\S]*?)\s*<\/dsh_mcp_call>/i

export function extractMcpCall(markdown: string): ParsedMcpCall | null {
  const match = MCP_CALL_RE.exec(markdown)

  if (!match) {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(match[1])
  } catch {
    throw new Error(
      'DeepSeek produced invalid MCP call JSON'
    )
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null
  ) {
    throw new Error(
      'DeepSeek MCP call must be an object'
    )
  }

  const value = parsed as Record<string, unknown>

  if (
    typeof value.tool !== 'string' ||
    !value.tool.startsWith('mcp__')
  ) {
    throw new Error(
      'Invalid MCP tool name'
    )
  }

  const args = value.arguments

  if (
    args !== undefined &&
    (
      typeof args !== 'object' ||
      args === null ||
      Array.isArray(args)
    )
  ) {
    throw new Error(
      'MCP arguments must be an object'
    )
  }

  return {
    tool: value.tool,
    arguments:
      (args as Record<string, unknown>) ?? {}
  }
}

export function buildMcpPrompt(tools: McpToolInfo[]): string {
  if (tools.length === 0) {
    return ''
  }

  const descriptions = tools
    .map(tool => {
      return [
        `### ${tool.name}`,
        tool.description ?? '',
        'Input schema:',
        '```json',
        JSON.stringify(
          tool.inputSchema ?? {},
          null,
          2
        ),
        '```'
      ].join('\n')
    })
    .join('\n\n')

  return `
You have access to the following MCP tools through DSH.

${descriptions}

To call an MCP tool, output exactly:

<dsh_mcp_call>
{"tool":"TOOL_NAME","arguments":{}}
</dsh_mcp_call>

Rules:
- Only call tools listed above.
- Never invent a tool result.
- Arguments must conform to the supplied schema.
- After receiving an MCP TOOL RESULT, continue the task.
- Do not explain the MCP protocol to the user unless asked.
`.trim()
}

export function buildMcpResultMessage(
  call: ParsedMcpCall,
  result: McpCallResult
): string {
  return [
    'MCP TOOL RESULT',
    '',
    `Tool: ${call.tool}`,
    '',
    'Result:',
    JSON.stringify(
      result,
      null,
      2
    ),
    '',
    'Continue the task using this tool result.',
    'Do not output another MCP call unless another tool is actually required.'
  ].join('\n')
}

export function buildMcpErrorMessage(
  call: ParsedMcpCall,
  error: unknown
): string {
  return [
    'MCP TOOL ERROR',
    '',
    `Tool: ${call.tool}`,
    '',
    'Error:',
    error instanceof Error
      ? error.message
      : String(error),
    '',
    'Continue the task if possible, or explain the error to the user.',
    'Do not output another MCP call unless another tool is actually required.'
  ].join('\n')
}
