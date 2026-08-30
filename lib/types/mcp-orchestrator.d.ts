/**
 * MCP orchestrator for the DeepSeek web-chat engine.
 *
 * Wraps engine.send() with an MCP tool-call loop: when DeepSeek replies
 * with a <dsh_mcp_call> block, the orchestrator executes the tool and
 * feeds the result back as a new user message, repeating up to maxRounds.
 */
import type { DeepSeekWebEngine } from './engine/engine.ts';
import type { SendResult } from './protocol.ts';
import { WebChatMcpBridge } from './mcp-bridge.ts';
export declare class McpOrchestrator {
    private readonly engine;
    private readonly bridge;
    private readonly maxRounds;
    private readonly enabled;
    constructor(engine: DeepSeekWebEngine, bridge: WebChatMcpBridge, maxRounds?: number, enabled?: boolean);
    send(message: string, wait: boolean, images?: string[]): Promise<SendResult>;
}
