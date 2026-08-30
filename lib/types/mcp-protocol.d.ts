/**
 * MCP call detection and prompt building for the DeepSeek web-chat protocol.
 *
 * DeepSeek outputs tool calls wrapped in <dsh_mcp_call> tags. This module
 * extracts them, validates them, and builds the prompt prefix that teaches
 * DeepSeek which tools are available and how to call them.
 */
import type { McpToolInfo, McpCallResult } from './mcp-bridge.ts';
export interface ParsedMcpCall {
    tool: string;
    arguments: Record<string, unknown>;
}
export declare function extractMcpCall(markdown: string): ParsedMcpCall | null;
export declare function buildMcpPrompt(tools: McpToolInfo[]): string;
export declare function buildMcpResultMessage(call: ParsedMcpCall, result: McpCallResult): string;
export declare function buildMcpErrorMessage(call: ParsedMcpCall, error: unknown): string;
