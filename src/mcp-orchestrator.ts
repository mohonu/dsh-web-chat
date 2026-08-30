/**
 * MCP orchestrator for the DeepSeek web-chat engine.
 *
 * Wraps engine.send() with an MCP tool-call loop: when DeepSeek replies
 * with a <dsh_mcp_call> block, the orchestrator executes the tool and
 * feeds the result back as a new user message, repeating up to maxRounds.
 */

import type { DeepSeekWebEngine } from './engine/engine.ts'
import type { SendResult } from './protocol.ts'
import { WebChatMcpBridge } from './mcp-bridge.ts'
import {
  extractMcpCall,
  buildMcpPrompt,
  buildMcpResultMessage,
  buildMcpErrorMessage,
} from './mcp-protocol.ts'

export class McpOrchestrator {
  constructor(
    private readonly engine: DeepSeekWebEngine,
    private readonly bridge: WebChatMcpBridge,
    private readonly maxRounds: number = 8,
    private readonly enabled: boolean = true
  ) {}

  async send(
    message: string,
    wait: boolean,
    images?: string[]
  ): Promise<SendResult> {
    if (!this.enabled) {
      return this.engine.send(message, wait, images)
    }

    const tools = this.bridge.listTools()
    const mcpPrompt = buildMcpPrompt(tools)
    const fullMessage = mcpPrompt
      ? `${mcpPrompt}

${message}`
      : message

    let currentMessage = fullMessage
    let lastResult: SendResult | undefined
    let currentImages = images

    for (let round = 0; round < this.maxRounds; round++) {
      const result = await this.engine.send(
        currentMessage,
        wait,
        currentImages
      )
      lastResult = result

      if (!result.ok || !result.reply) {
        break
      }

      let mcpCall: ReturnType<typeof extractMcpCall>
      try {
        mcpCall = extractMcpCall(result.reply)
      } catch {
        // Malformed MCP call in reply — stop looping and return as-is.
        break
      }

      if (!mcpCall) {
        break
      }

      try {
        const toolResult = await this.bridge.callTool(mcpCall)
        currentMessage = buildMcpResultMessage(mcpCall, toolResult)
      } catch (error) {
        currentMessage = buildMcpErrorMessage(mcpCall, error)
      }

      currentImages = undefined
    }

    return (
      lastResult ?? {
        ok: false,
        error: 'MCP orchestrator failed to produce a result'
      }
    )
  }
}
