/**
 * Bridge between dsh-webchat and the DSH native tool registry.
 *
 * dsh-mcp-client registers external MCP tools into ctx.tools as:
 *   mcp__<server>__<tool>
 *
 * We deliberately expose ONLY tools with the mcp__ prefix.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
export interface McpCallRequest {
    tool: string;
    arguments?: Record<string, unknown>;
}
export interface McpCallResult {
    content?: unknown;
    isError?: boolean;
    [key: string]: unknown;
}
export declare class WebChatMcpBridge {
    private readonly ctx;
    constructor(ctx: Context);
    listTools(): McpToolInfo[];
    callTool(request: McpCallRequest): Promise<McpCallResult>;
}
