/**
 * The web-chat panel: engine/login status, a conversation sidebar (the local
 * transcript list + management), the chat transcript with markdown rendering,
 * streaming updates (polled), the composer with deep-think / internet-search
 * toggles, and the transfer-to-Harness handoff. All data flows through the
 * /api/dsh-webchat routes; the panel is a plain React root in the center column.
 *
 * Layout mirrors chat.deepseek.com: a left conversation sidebar (new chat +
 * history + per-item rename/delete + clear-all) beside the main chat column
 * (messages → composer with 深度思考 / 智能搜索 toggles → handoff dock). The
 * mono register stays reserved for machine things — timestamps, counts,
 * status, and the handoff eyebrow.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebChatApi } from '../api.ts'
import type { TransferMode, WebChatState, WebChatTranscript } from '../../protocol.ts'
import type { WebChatKey } from '../locales.ts'
import { Markdown } from './Markdown.tsx'
import css from './panel.module.css'

/** Interpolate {placeholder}s in a localized template. */
function fmt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`)
}

/** Compact inline icons (stroke = currentColor, 16px viewBox). */
const PENCIL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.2l2.5 2.5L5.5 13H3v-2.5L11.3 2.2z"/></svg>'
const TRASH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.5 9.5h7L12 4"/></svg>'
const CHECK_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5L6.5 12 13 4.5"/></svg>'
const CROSS_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

export interface WebChatPanelProps {
  api: WebChatApi
  /** Locale accessor (the plugin registers its dictionaries on ctx.locale). */
  tt: (key: WebChatKey) => string
  /** Client sessions service (ctx.sessions) for opening transferred sessions. */
  sessions: ISessions
  /** Resolve the current workspace directory (cwd for new sessions / exports). */
  currentCwd: () => string | undefined
}

/** Time between /state polls while nothing is streaming. */
const POLL_IDLE_MS = 1_500
/** Faster polling while a reply is streaming. */
const POLL_STREAM_MS = 600

export function WebChatPanel({ api, tt, sessions, currentCwd }: WebChatPanelProps) {
  const [state, setState] = useState<WebChatState | null>(null)
  const [viewChatId, setViewChatId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [transferMode, setTransferMode] = useState<TransferMode>('distill')
  const [deepThink, setDeepThink] = useState(false)
  const [search, setSearch] = useState(false)
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteArmId, setDeleteArmId] = useState<string | undefined>(undefined)
  const [clearArm, setClearArm] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const armTimer = useRef<number | undefined>(undefined)
  const stateRef = useRef<WebChatState | null>(null)
  stateRef.current = state
  const pinnedRef = useRef(true) // user is following the latest message (not scrolled up)
  const prevChatRef = useRef<string | undefined>(undefined)

  const showToast = useCallback((text: string, error = false): void => {
    setToast({ text, error })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5_000)
  }, [])

  // Poll /state.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      if (cancelled) return
      try {
        const snapshot = await api.state()
        if (cancelled) return
        setState(snapshot)
        setViewChatId(previous => {
          const active = snapshot.activeChatId
          if (previous !== undefined && snapshot.chats.some(chat => chat.id === previous)) return previous
          return active
        })
      } catch {
        // transient poll failure: keep the previous snapshot
      }
      const streaming = stateRef.current?.chats.some(chat => chat.streaming) ?? false
      timer = window.setTimeout(poll, streaming ? POLL_STREAM_MS : POLL_IDLE_MS)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [api])

  // Reconcile the web page's toggle state whenever the server reports it.
  useEffect(() => {
    if (state === null) return
    setDeepThink(state.deepThink)
    setSearch(state.search)
  }, [state?.deepThink, state?.search])

  // Auto-scroll to the bottom only when the user is following the latest
  // message (pinned) or has just switched chats — never yank the view while
  // they are reading history.
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const switched = prevChatRef.current !== viewChatId
    prevChatRef.current = viewChatId
    if (switched || pinnedRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [state, viewChatId])

  // Track whether the user has scrolled away from the bottom.
  const handleScroll = useCallback((): void => {
    const list = listRef.current
    if (list === null) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96
    pinnedRef.current = nearBottom
  }, [])

  const chats: WebChatTranscript[] = state?.chats ?? []
  const viewChat = chats.find(chat => chat.id === viewChatId) ?? chats[0]
  const busy = state?.busy ?? false
  const loggedIn = state?.loggedIn ?? null
  const streaming = viewChat?.streaming ?? false

  const modelLabel = useCallback((model: string): string => {
    return model === 'deepseek-reasoner' ? tt('model.deepseek-reasoner') : tt('model.deepseek-chat')
  }, [tt])

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    pinnedRef.current = true // follow the reply we just sent
    try {
      const result = await api.send(text)
      if (result.ok !== true) showToast(result.error ?? 'send failed', true)
      else setViewChatId(result.chatId)
    } catch (error) {
      showToast(String(error), true)
    }
  }, [draft, busy, api, showToast])

  const stop = useCallback(async (): Promise<void> => {
    await api.stop().catch(() => undefined)
  }, [api])

  const newChat = useCallback(async (): Promise<void> => {
    try {
      const result = await api.newChat()
      if (result.ok === true && result.chatId !== undefined) setViewChatId(result.chatId)
      else showToast(result.error ?? 'new chat failed', true)
    } catch (error) {
      showToast(String(error), true)
    }
  }, [api, showToast])

  const toggleDeepThink = useCallback(async (): Promise<void> => {
    const next = !deepThink
    setDeepThink(next)
    try {
      const result = await api.setDeepThink(next)
      if (result.ok !== true) showToast(result.error ?? 'toggle deep think failed', true)
    } catch (error) {
      showToast(String(error), true)
    }
  }, [deepThink, api, showToast])

  const toggleSearch = useCallback(async (): Promise<void> => {
    const next = !search
    setSearch(next)
    try {
      const result = await api.setSearch(next)
      if (result.ok !== true) showToast(result.error ?? 'toggle search failed', true)
    } catch (error) {
      showToast(String(error), true)
    }
  }, [search, api, showToast])

  const openLogin = useCallback(async (): Promise<void> => {
    try {
      const result = await api.openLogin()
      if (result.ok !== true) showToast(result.error ?? 'open login failed', true)
    } catch (error) {
      showToast(String(error), true)
    }
  }, [api, showToast])

  const closeBrowser = useCallback(async (): Promise<void> => {
    await api.closeBrowser().catch(() => undefined)
  }, [api])

  const transferToHarness = useCallback(async (): Promise<void> => {
    if (viewChat === undefined || transferring) return
    setTransferring(true)
    try {
      const result = await api.transfer(viewChat.id, currentCwd(), transferMode)
      if (result.ok !== true || result.sessionId === undefined) {
        showToast(result.error ?? 'transfer failed', true)
        return
      }
      showToast(fmt(tt('transfer.done'), { sessionId: result.sessionId }))
      const target = result.sessionId
      // The session is persisted cold, so the cached list does not know about
      // it yet. Trigger a full list refresh (concrete-only on the runtime
      // sessions service), then poll until the row lands and open it.
      const refreshable = sessions as ISessions & { refresh?: () => Promise<void> }
      try {
        await refreshable.refresh?.()
      } catch {
        // Refresh is best-effort; fall through to the poll below.
      }
      const tryOpen = (): void => {
        const snapshot = sessions.list.getSnapshot()
        if (snapshot.byId[target as SessionId] !== undefined) {
          sessions.open(target as SessionId)
          return
        }
        window.setTimeout(tryOpen, 300)
      }
      window.setTimeout(tryOpen, 200)
    } catch (error) {
      showToast(String(error), true)
    } finally {
      setTransferring(false)
    }
  }, [viewChat, transferring, api, currentCwd, sessions, showToast, tt, transferMode])

  const exportFile = useCallback(async (): Promise<void> => {
    if (viewChat === undefined || exporting) return
    setExporting(true)
    try {
      const result = await api.exportFile(viewChat.id, currentCwd())
      if (result.ok !== true || result.filePath === undefined) {
        showToast(result.error ?? 'export failed', true)
      } else {
        showToast(fmt(tt('export.done'), { filePath: result.filePath }))
      }
    } catch (error) {
      showToast(String(error), true)
    } finally {
      setExporting(false)
    }
  }, [viewChat, exporting, api, currentCwd, showToast, tt])

  // --- transcript management (rename / delete / clear-all) -------------------
  const resetArmTimer = useCallback((next: (() => void) | undefined): void => {
    window.clearTimeout(armTimer.current)
    armTimer.current = next === undefined ? undefined : window.setTimeout(next, 3_000)
  }, [])

  const startRename = useCallback((chat: WebChatTranscript): void => {
    setDeleteArmId(undefined)
    setClearArm(false)
    setRenameDraft(chat.title)
    setRenamingId(chat.id)
  }, [])

  const commitRename = useCallback(async (): Promise<void> => {
    const id = renamingId
    if (id === undefined) return
    const title = renameDraft.trim().replace(/\s+/g, ' ')
    setRenamingId(undefined)
    const original = chats.find(chat => chat.id === id)
    if (title === '' || (original !== undefined && title === original.title)) return
    try {
      const result = await api.renameChat(id, title)
      if (result.ok !== true) showToast(fmt(tt('toast.rename.failed'), { error: result.error ?? '' }), true)
      else showToast(tt('toast.rename.done'))
    } catch (error) {
      showToast(fmt(tt('toast.rename.failed'), { error: String(error) }), true)
    }
  }, [renamingId, renameDraft, chats, api, showToast, tt])

  const cancelRename = useCallback((): void => {
    setRenamingId(undefined)
    setRenameDraft('')
  }, [])

  const requestDelete = useCallback(async (id: string): Promise<void> => {
    if (deleteArmId !== id) {
      setClearArm(false)
      setRenamingId(undefined)
      setDeleteArmId(id)
      resetArmTimer(() => setDeleteArmId(undefined))
      return
    }
    resetArmTimer(undefined)
    setDeleteArmId(undefined)
    try {
      const result = await api.deleteChat(id)
      if (result.ok !== true) showToast(fmt(tt('toast.delete.failed'), { error: result.error ?? '' }), true)
      else showToast(tt('toast.delete.done'))
    } catch (error) {
      showToast(fmt(tt('toast.delete.failed'), { error: String(error) }), true)
    }
  }, [deleteArmId, api, showToast, tt, resetArmTimer])

  const requestClear = useCallback(async (): Promise<void> => {
    if (chats.length === 0) return
    if (!clearArm) {
      setDeleteArmId(undefined)
      setRenamingId(undefined)
      setClearArm(true)
      resetArmTimer(() => setClearArm(false))
      return
    }
    resetArmTimer(undefined)
    setClearArm(false)
    try {
      const result = await api.clearChats()
      if (result.ok !== true) showToast(fmt(tt('toast.clear.failed'), { error: result.error ?? '' }), true)
      else showToast(tt('toast.clear.done'))
    } catch (error) {
      showToast(fmt(tt('toast.clear.failed'), { error: String(error) }), true)
    }
  }, [chats.length, clearArm, api, showToast, tt, resetArmTimer])

  const engineState = state?.engine ?? 'stopped'
  const engineError = state?.engineError
  const statusDot: 'ok' | 'warn' | 'bad' | 'busy' =
    busy ? 'busy'
      : engineState === 'error' ? 'bad'
        : loggedIn === true ? 'ok'
          : 'warn'
  const statusText = busy
    ? tt('composer.busy')
    : engineState === 'error'
      ? `${tt('status.engine.error')}${engineError !== undefined ? `: ${engineError}` : ''}`
      : engineState === 'launching'
        ? tt('status.engine.launching')
        : loggedIn === true
          ? tt('status.loggedIn')
          : loggedIn === false
            ? tt('status.notLoggedIn')
            : tt('status.unknown')

  const togglesDisabled = busy || loggedIn !== true

  return (
    <div className={css.panel}>
      {/* Identity + live status */}
      <header className={css.panelHeader}>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
        <div className={css.headerSpacer} />
        <div className={css.statusChip}>
          <span className={css.statusDot} data-state={statusDot} />
          <span className={css.statusText}>{statusText}</span>
        </div>
        {loggedIn !== true && (
          <button className={`${css.button} ${css.buttonPrimary}`} onClick={() => { void openLogin() }}>
            {tt('action.openLogin')}
          </button>
        )}
        {engineState !== 'stopped' && (
          <button className={css.buttonGhost} onClick={() => { void closeBrowser() }}>
            {tt('action.closeBrowser')}
          </button>
        )}
      </header>

      <div className={css.panelBody}>
        {/* Conversation sidebar (chat history + management) */}
        <aside className={css.sidebar}>
          <button className={`${css.button} ${css.buttonPrimary} ${css.sidebarNew}`} onClick={() => { void newChat() }}>
            {tt('action.newChat')}
          </button>
          <div className={css.sidebarList}>
            {chats.length === 0 ? (
              <div className={css.sidebarEmpty}>{tt('sidebar.empty')}</div>
            ) : (
              chats.map(chat => (
                renamingId === chat.id ? (
                  <div className={css.sidebarItem} data-active={chat.id === viewChatId ? 'true' : undefined} key={chat.id}>
                    <div className={css.sidebarRename}>
                      <input
                        className={css.sidebarRenameInput}
                        value={renameDraft}
                        placeholder={tt('chat.rename.placeholder')}
                        aria-label="rename"
                        autoFocus
                        onChange={event => setRenameDraft(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void commitRename()
                          } else if (event.key === 'Escape') {
                            cancelRename()
                          }
                        }}
                      />
                      <button className={css.sidebarAction} onClick={() => { void commitRename() }} aria-label={tt('chat.rename.ok')} dangerouslySetInnerHTML={{ __html: CHECK_ICON }} />
                      <button className={css.sidebarAction} onClick={cancelRename} aria-label={tt('chat.rename.cancel')} dangerouslySetInnerHTML={{ __html: CROSS_ICON }} />
                    </div>
                  </div>
                ) : (
                  <div className={css.sidebarItem} data-active={chat.id === viewChatId ? 'true' : undefined} key={chat.id}>
                    <button className={css.sidebarRow} onClick={() => setViewChatId(chat.id)} title={chat.title}>
                      <span className={css.sidebarTitle}>{chat.title}</span>
                      <span className={css.sidebarMeta}>{fmt(tt('chats.count'), { count: String(chat.messages.length) })}</span>
                    </button>
                    <span className={css.sidebarActions}>
                      <button className={css.sidebarAction} onClick={() => startRename(chat)} aria-label={tt('chat.rename')} title={tt('chat.rename')} dangerouslySetInnerHTML={{ __html: PENCIL_ICON }} />
                      <button
                        className={deleteArmId === chat.id ? css.sidebarActionDanger : css.sidebarAction}
                        onClick={() => { void requestDelete(chat.id) }}
                        aria-label={deleteArmId === chat.id ? tt('chat.delete.confirm') : tt('chat.delete')}
                        title={deleteArmId === chat.id ? tt('chat.delete.confirm') : tt('chat.delete')}
                      >
                        {deleteArmId === chat.id ? tt('chat.delete.confirm') : <span dangerouslySetInnerHTML={{ __html: TRASH_ICON }} />}
                      </button>
                    </span>
                  </div>
                )
              ))
            )}
          </div>
          <button
            className={clearArm ? `${css.button} ${css.buttonDanger} ${css.sidebarClear}` : `${css.buttonGhost} ${css.sidebarClear}`}
            disabled={chats.length === 0}
            onClick={() => { void requestClear() }}
          >
            {clearArm ? tt('chat.clearAll.confirm') : tt('chat.clearAll')}
          </button>
        </aside>

        {/* Main chat column */}
        <div className={css.main}>
          <div className={css.messageList} ref={listRef} onScroll={handleScroll}>
            {viewChat === undefined || viewChat.messages.length === 0 ? (
              <div className={css.emptyState}>
                <div className={css.emptyEyebrow}>{tt('empty.eyebrow')}</div>
                <h3 className={css.emptyTitle}>{tt('empty.title')}</h3>
                <p className={css.emptyBody}>{tt('empty.body')}</p>
                {loggedIn !== true && (
                  <button className={`${css.button} ${css.buttonPrimary}`} onClick={() => { void openLogin() }}>
                    {tt('action.openLogin')}
                  </button>
                )}
              </div>
            ) : (
              viewChat.messages.map(message => (
                <div className={css.messageRow} data-role={message.role} key={message.id}>
                  <div className={css.messageMeta}>
                    <span className={css.messageSpeaker}>{message.role === 'user' ? tt('role.you') : modelLabel(viewChat.model)}</span>
                    <span className={css.messageTime}>{new Date(message.ts).toLocaleTimeString()}</span>
                    {message.streaming === true && <span className={css.streamBadge}>{tt('streaming')}…</span>}
                  </div>
                  <div className={css.messageBubble}>
                    <Markdown source={message.content} />
                    {message.error !== undefined && message.content !== '' && (
                      <div className={css.messageError}>{fmt(tt('msg.error'), { error: message.error })}</div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={css.composer}>
            <div className={css.composerToolbar}>
              <button
                className={css.toggleButton}
                data-active={deepThink ? 'true' : undefined}
                disabled={togglesDisabled}
                title={tt('toggle.deepThink.hint')}
                aria-pressed={deepThink}
                onClick={() => { void toggleDeepThink() }}
              >
                {tt('toggle.deepThink')}
              </button>
              <button
                className={css.toggleButton}
                data-active={search ? 'true' : undefined}
                disabled={togglesDisabled}
                title={tt('toggle.search.hint')}
                aria-pressed={search}
                onClick={() => { void toggleSearch() }}
              >
                {tt('toggle.search')}
              </button>
            </div>
            <textarea
              className={css.composerInput}
              value={draft}
              placeholder={busy ? tt('composer.busy') : loggedIn !== true ? tt('composer.notLoggedIn') : tt('composer.placeholder')}
              disabled={busy || loggedIn !== true}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className={css.composerFooter}>
              <span className={css.composerHint}>{tt('composer.hint')}</span>
              <div className={css.composerSpacer} />
              {streaming ? (
                <button className={`${css.button} ${css.buttonDanger}`} onClick={() => { void stop() }}>
                  {tt('action.stop')}
                </button>
              ) : (
                <button
                  className={`${css.button} ${css.buttonPrimary}`}
                  disabled={busy || loggedIn !== true || draft.trim() === ''}
                  onClick={() => { void send() }}
                >
                  {tt('action.send')}
                </button>
              )}
            </div>
          </div>

          {/* Handoff dock — the chat → harness gateway (signature) */}
          <div className={css.handoffDock}>
            <span className={css.handoffEyebrow}>{tt('handoff.eyebrow')}</span>
            <div className={css.handoffSpacer} />
            <div className={css.segmented} role="group" aria-label="transfer mode" title={tt('transfer.mode.hint')}>
              <button
                className={css.segmentedButton}
                data-active={transferMode === 'distill' ? 'true' : undefined}
                onClick={() => setTransferMode('distill')}
              >
                {tt('transfer.mode.distill')}
              </button>
              <button
                className={css.segmentedButton}
                data-active={transferMode === 'raw' ? 'true' : undefined}
                onClick={() => setTransferMode('raw')}
              >
                {tt('transfer.mode.raw')}
              </button>
            </div>
            <button
              className={`${css.button} ${css.buttonPrimary}`}
              disabled={viewChat === undefined || transferring}
              onClick={() => { void transferToHarness() }}
            >
              {tt('action.transferToHarness')}
            </button>
            <button className={css.button} disabled={viewChat === undefined || exporting} onClick={() => { void exportFile() }}>
              {tt('action.exportFile')}
            </button>
          </div>
        </div>
      </div>

      {toast !== null && <div className={css.toast} data-error={toast.error === true ? 'true' : undefined}>{toast.text}</div>}
    </div>
  )
}
