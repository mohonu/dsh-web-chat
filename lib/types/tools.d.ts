/**
 * Agent tools: the DSH-native counterpart of the web-chat panel. The harness
 * agent can chat through the DeepSeek web session (webchat_send), inspect
 * stored transcripts (webchat_status / webchat_import), and hand a web
 * conversation into a new harness session (webchat_transfer) — mirroring how
 * Codex's chatgpt mode lets the agent itself use the web subscription.
 */
import type { DeepSeekWebEngine } from './engine/engine.ts';
import type { TranscriptStore } from './store.ts';
import type { WebChatMcpBridge } from './mcp-bridge.ts';
/** Minimal workspace projection surfaced to the agent (id/path/title only). */
export interface WorkspaceRef {
    id: string;
    path: string;
    title: string;
}
/** The engine-status tool. */
export declare function webChatStatusTool(engine: DeepSeekWebEngine, store: TranscriptStore, listWorkspaces?: () => WorkspaceRef[] | undefined, mcpBridge?: WebChatMcpBridge): import("@deepseek-ai/dsh-tools").ToolDefinition;
