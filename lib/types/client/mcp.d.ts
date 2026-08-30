/**
 * Browser-side MCP client for the dsh-webchat panel.
 *
 * Lets the web panel discover available MCP tools and optionally render
 * them to the user (read-only; actual execution stays on the host).
 */
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
export interface McpCallResult {
    content?: unknown;
    isError?: boolean;
    [key: string]: unknown;
}
export declare function getMcpTools(): Promise<McpToolInfo[]>;
export declare function callMcpTool(tool: string, args?: Record<string, unknown>): Promise<McpCallResult>;
