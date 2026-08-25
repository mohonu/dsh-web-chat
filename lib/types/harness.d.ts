/**
 * Read-only harness-session listing for the "continue into an existing
 * session" picker. The client `sessions.list` feed is scoped to the active
 * workspace view, so the picker needs an explicit ALL-sessions source; this
 * enumerates both live (attached) and cold (persisted) sessions directly,
 * deriving a readable title from the session-projection cache (zero log
 * loads) with a cwd-basename fallback.
 */
import type { Context } from '@deepseek-ai/cordis';
/** One harness session row for the continuation target picker. */
export interface HarnessSessionRow {
    sessionId: string;
    title: string;
    running: boolean;
    blank: boolean;
}
/** List every harness session (live + cold) with a readable title, newest first. */
export declare function listHarnessSessions(ctx: Context): Promise<HarnessSessionRow[]>;
