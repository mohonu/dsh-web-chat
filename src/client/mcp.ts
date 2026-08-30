/**
 * Browser-side MCP client for the dsh-webchat panel.
 *
 * Lets the web panel discover available MCP tools and optionally render
 * them to the user (read-only; actual execution stays on the host).
 */

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content?: unknown
  isError?: boolean
  [key: string]: unknown
}

export async function getMcpTools(): Promise<McpToolInfo[]> {
  const response = await fetch(
    '/api/webchat/mcp/tools',
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    }
  )

  if (!response.ok) {
    throw new Error(
      `MCP tool discovery failed: HTTP ${response.status}`
    )
  }

  const data = await response.json()

  if (!data.ok) {
    throw new Error(
      data.error ?? 'MCP discovery failed'
    )
  }

  return Array.isArray(data.tools)
    ? data.tools
    : []
}

export async function callMcpTool(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<McpCallResult> {
  const response = await fetch(
    '/api/webchat/mcp/call',
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        tool,
        arguments: args
      })
    }
  )

  const data = await response.json()

  if (!response.ok || !data.ok) {
    throw new Error(
      data.error ??
      `MCP call failed: HTTP ${response.status}`
    )
  }

  return data.result
}
