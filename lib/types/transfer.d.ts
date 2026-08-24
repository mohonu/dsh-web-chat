/**
 * Harness-mode transfer: turn a web-chat transcript into development context.
 *
 * This is the "Continue in Codex" / ChatGPT-mode analog, and like Codex it is
 * a CONTEXT HANDOFF rather than a raw replay: the exploration-phase web
 * conversation is distilled (via the harness LLM) into an executable task
 * brief — the execution-phase state representation the agent actually needs —
 * and that brief seeds a fresh harness session. The raw transcript is kept as
 * the fallback when distillation is unavailable.
 *
 * Two targets:
 *  - new harness session — a COLD persisted session seeded with the distilled
 *    brief (or raw transcript), so it shows up in the GUI list and resumes;
 *  - workspace file — the raw transcript rendered to markdown in the target
 *    project directory, so any agent can read it with file tools.
 *
 * Session creation writes directly through the session-persistence backend
 * (`sessionPersistence.create` + `append`), NOT `ctx.sessions.create()`:
 * the store's `create` produces a LIVE session owned by the calling fiber,
 * which the GUI then refuses to resume ("cannot prepare … while it is live").
 * A cold persisted session is exactly what the GUI's resume path expects.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { TransferMode, WebChatTranscript } from './protocol.ts';
/** Render one transcript to markdown for harness consumption. */
export declare function renderTranscriptMarkdown(transcript: WebChatTranscript, options?: {
    excludeThinking?: boolean;
}): string;
/**
 * Framing that turns the distilled brief into established context for the
 * agent — the analog of Codex's "another model started to solve this problem
 * and produced a summary; use it to build on the work already done".
 */
export declare const HANDOFF_PREAMBLE = "\u8FD9\u662F\u4E00\u6B21\u4ECE DeepSeek \u7F51\u9875\u7AEF\u4F1A\u8BDD\uFF08chat.deepseek.com\uFF09\u8F6C\u6765\u7684\u4E0A\u4E0B\u6587\u4EA4\u63A5\u3002\u4E0B\u9762\u7684\u4EFB\u52A1\u7B80\u62A5\u5DF2\u628A\u8BE5\u5BF9\u8BDD\u63D0\u70BC\u4E3A\u53EF\u6267\u884C\u7684\u4EFB\u52A1\u4E0A\u4E0B\u6587\u2014\u2014\u628A\u5B83\u5F53\u4F5C\u65E2\u5B9A\u76EE\u6807\u4E0E\u80CC\u666F\uFF0C\u76F4\u63A5\u5728\u5176\u57FA\u7840\u4E0A\u7EE7\u7EED\uFF0C\u4E0D\u8981\u590D\u8FF0\u3002";
/** Transfer distillation settings (resolved from the plugin config surface). */
export interface DistillConfig {
    /** When true (default), distill the transcript into a task brief via ctx.llm. */
    distill: boolean;
    /** Provider route for the distillation call; empty = auto-detect. */
    provider: string;
    /** Model id for the distillation call; empty = auto-detect. */
    model: string;
}
/** A successful distillation result. */
export interface DistillResult {
    brief: string;
    provider: string;
    model: string;
}
/**
 * Distill a web transcript into an executable task brief via the harness LLM.
 * Returns undefined (so callers fall back to the raw transcript) when the LLM
 * service, a provider/model, or a clean completion is unavailable.
 */
export declare function distillTranscriptToBrief(ctx: Context, transcript: WebChatTranscript, config: DistillConfig): Promise<DistillResult | undefined>;
/** Build the seed user-message event carrying the handoff text. */
export declare function transcriptSeedEvent(markdown: string): SessionEvent<'user/message'>;
export interface TransferWorkspaceTarget {
    /** Stable workspace id (from the registry / GUI picker); wins over `path`. */
    workspaceId?: string;
    /** Directory path to use as the session cwd (optionally resolves to a workspace). */
    path?: string;
}
export interface TransferToSessionInput {
    transcript: WebChatTranscript;
    cwd?: string;
    /** Target workspace; when set, the session is grouped under it (attached). */
    workspace?: TransferWorkspaceTarget;
}
/** Resolved transfer destination: the session cwd plus an optional owning workspace. */
export interface ResolvedTransferTarget {
    cwd: string;
    workspace?: Workspace;
}
/** The result of creating a transferred harness session. */
export interface TransferToSessionResult {
    sessionId: string;
    distilled: boolean;
    /** True when the session was attached to a workspace; false = ungrouped. */
    attached: boolean;
    /** Workspace id the session landed in, when attached. */
    workspaceId?: string;
}
/**
 * Create a new COLD harness session seeded with a distilled task brief (or the
 * raw transcript when the user chooses 'raw' / distillation is unavailable),
 * written straight through the session-persistence backend so the GUI lists it
 * and can resume it later (no live-store ownership). When `input.workspace`
 * names a registered workspace, the session's cwd is set to that workspace's
 * canonical path and the session is attached to the workspace's account, so
 * the GUI groups it under that workspace instead of "ungrouped".
 *
 * `mode` is the user's explicit choice; when undefined the plugin config
 * default (`transferDistill`) applies.
 */
export declare function transferToHarnessSession(ctx: Context, input: TransferToSessionInput, config: DistillConfig, mode?: TransferMode): Promise<TransferToSessionResult>;
export interface ExportTranscriptInput {
    transcript: WebChatTranscript;
    cwd?: string;
}
/** Write the transcript markdown into the target directory; returns the path. */
export declare function exportTranscriptFile(input: ExportTranscriptInput): {
    filePath: string;
};
