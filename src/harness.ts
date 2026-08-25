/**
 * Read-only harness-session listing for the "continue into an existing
 * session" picker. The client `sessions.list` feed is scoped to the active
 * workspace view, so the picker needs an explicit ALL-sessions source; this
 * enumerates both live (attached) and cold (persisted) sessions directly,
 * deriving a readable title from the session-projection cache (zero log
 * loads) with a cwd-basename fallback.
 */

import type { Context } from '@deepseek-ai/cordis'

/** One harness session row for the continuation target picker. */
export interface HarnessSessionRow {
  sessionId: string
  title: string
  running: boolean
  blank: boolean
}

/** Display title from a session's working directory (last path segment). */
function cwdTitle(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '（未命名会话）'
  const segments = cwd.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? '（未命名会话）'
}

/** Read the `title` projection value, falling back to the cwd basename. */
function titleOf(values: Record<string, unknown> | undefined, cwd: string | undefined): string {
  const title = values?.['title']
  return typeof title === 'string' && title !== '' ? title : cwdTitle(cwd)
}

/** Read the `sessionListMetadata.blank` projection value (default: not blank). */
function blankOf(values: Record<string, unknown> | undefined): boolean {
  const metadata = values?.['sessionListMetadata'] as { blank?: boolean } | undefined
  return metadata?.blank === true
}

interface ProjectionSnapshot { values?: Record<string, unknown> }

/** List every harness session (live + cold) with a readable title, newest first. */
export async function listHarnessSessions(ctx: Context): Promise<HarnessSessionRow[]> {
  const projections = ctx.get('sessionProjections') as { snapshot?: (session: unknown) => ProjectionSnapshot | undefined } | undefined
  const cache = ctx.get('sessionProjectionCache') as { cachedSnapshot?: (meta: unknown) => ProjectionSnapshot | undefined } | undefined
  const agents = ctx.get('agents') as { get?: (id: string) => { status?: string } | undefined } | undefined

  const rows: Array<HarnessSessionRow & { createdAt: number }> = []
  const seen = new Set<string>()

  // Live (attached) sessions carry their events and a live projection cut.
  for (const session of ctx.sessions.list()) {
    seen.add(session.id)
    const values = projections?.snapshot?.(session)?.values
    rows.push({
      sessionId: session.id,
      title: titleOf(values, session.header.cwd),
      running: agents?.get?.(session.id)?.status === 'running',
      blank: blankOf(values),
      createdAt: session.header.createdAt,
    })
  }

  // Cold persisted sessions: headers only, titles from the projection cache.
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    for (const meta of await persistence.list()) {
      if (seen.has(meta.id) || meta.cwd === undefined) continue
      const values = cache?.cachedSnapshot?.(meta)?.values
      rows.push({
        sessionId: meta.id,
        title: titleOf(values, meta.cwd),
        running: false,
        blank: blankOf(values),
        createdAt: meta.createdAt,
      })
    }
  }

  rows.sort((left, right) => right.createdAt - left.createdAt)
  return rows.map(({ createdAt: _createdAt, ...row }) => row)
}
