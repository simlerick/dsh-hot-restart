/**
 * dsh-hot-restart — renderer half.
 *
 * This file is a CLASSIC SCRIPT, not an ES module: it must run through
 * `window.__ModuleLoader__.load` so the Desktop web shell can install it.
 * Therefore no `import`, no JSX, and only the whitelisted `require` targets.
 *
 * Why the restart lives here: the shell's `harness:restart` IPC validates
 * `event.sender === mainWindow.webContents`, so an external process (or the
 * Host half of this plugin) cannot trigger an official restart. This bundle
 * runs inside that very renderer, which makes `window.dshDesktop.restartHarness()`
 * the one supported entry point — and it swaps only the Harness child process,
 * so the shell never sees a crash.
 *
 * Where the UI lives: a **Settings section**, not a sidebar panel. A restart is
 * a maintenance action, not a workspace surface; the settings column is where
 * one-off host operations belong. The consequence is that this half cannot rely
 * on "the conversation you have open" — Settings is reachable from anywhere —
 * so it lists conversations and asks which one should be resumed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hot-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Settings section id; also the locale-independent key. */
    const SECTION_ID = 'dsh-hot-restart'

    /** Idle poll interval; the panel refreshes the ledger view on this cadence. */
    const POLL_MS = 3000
    /** How often the renderer asks "should I restart now?". */
    const DISPATCH_MS = 1000

    const zh = {
      nav: '热重启',
      title: 'DSH 热重启',
      subtitle: '重启 Harness 进程，并在重启后回到你指定的对话继续。',
      target: '重启后唤醒哪个对话',
      targetHint: '选择要在重启后被唤醒的对话。只有这个对话会收到继续指令，其它对话不受影响。',
      targetPlaceholder: '选择一个对话…',
      targetEmpty: '没有可选的对话。',
      targetCurrent: '当前打开的对话',
      reason: '重启原因',
      reasonPlaceholder: '例如：安装新插件后需要重载宿主',
      prompt: '唤醒词（只发给你当前这个对话）',
      promptPlaceholder: '留空则自动生成；其他对话永远收到各自专属的续接指令',
      schedule: '安排重启',
      cancel: '取消',
      pending: '待唤醒',
      noPending: '没有待处理的唤醒',
      lastWake: '上次唤醒',
      history: '历史',
      boot: '本次宿主',
      previousBoot: '上一宿主',
      ledger: '账本',
      unsupported: '这台机器上找不到可用的重启通道：桌面外壳没有官方重启入口，也没有找到 dsh-restart 助手脚本。',
      channel: '重启通道',
      channelRenderer: '桌面外壳官方入口（Windows）',
      channelLaunchd: 'launchd 助手（macOS）',
      channelNone: '不可用',
      channelHintRenderer: '由本窗口调用 window.dshDesktop.restartHarness() 完成重启。',
      channelHintLaunchd: '由宿主直接调用 dsh-restart，经 launchd 脱离进程组后重开应用。',
      channelHintNone: '既没有官方入口也没有助手脚本，无法自动重启。',
      scheduled: '已安排重启，正在交给桌面外壳执行。',
      scheduledLaunchd: '已安排重启，宿主已交给 launchd 助手执行。',
      cancelled: '已取消。',
      failed: '失败',
      woken: '已唤醒',
      refused: '已拒绝',
      sessionRequired: '请先选择一个要唤醒的对话。',
      busy: '处理中…',
      enabled: '自动唤醒：已开启',
      disabled: '自动唤醒：已关闭（需手动处理待唤醒）',
      refresh: '刷新',
      onceHint: '安排后约 1–2 秒应用会重启一次；重启完成后，被选中的对话和所有正在跑任务的对话都会收到「继续」指令。',
      wakeAll: '同时唤醒所有正在执行任务的对话',
      wakeAllHint: '重启会替换整个进程，所以每个被打断的对话都需要在新进程里继续。每个对话收到的是它自己专属的续接指令（基于它自己最后在做什么），上面填的唤醒词只发给你选中的这个对话。',
      resumable: '需要继续的对话',
      resumableNone: '当前没有正在执行任务的对话。',
      resumableRunning: '正在执行任务',
      resumableMidTurn: '上次被中断（未收尾）',
      willWake: '将唤醒',
      refusedList: '未唤醒',
    }

    const en = {
      nav: 'Hot restart',
      title: 'DSH hot restart',
      subtitle: 'Restart the Harness process, then resume the conversation you pick.',
      target: 'Conversation to wake',
      targetHint: 'Pick the conversation that should be resumed after the restart. Only that one receives the continue instruction; every other conversation is untouched.',
      targetPlaceholder: 'Select a conversation…',
      targetEmpty: 'No conversations available.',
      targetCurrent: 'Currently open',
      reason: 'Reason',
      reasonPlaceholder: 'e.g. reload the Host after installing a plugin',
      prompt: 'Wake message (this conversation only)',
      promptPlaceholder: 'Leave empty to auto-generate; other conversations always get their own continuation',
      schedule: 'Schedule restart',
      cancel: 'Cancel',
      pending: 'Pending wake',
      noPending: 'No pending wake',
      lastWake: 'Last wake',
      history: 'History',
      boot: 'This Host',
      previousBoot: 'Previous Host',
      ledger: 'Ledger',
      unsupported: 'No restart channel is available on this machine: the desktop shell exposes no official restart entry and no dsh-restart helper was found.',
      channel: 'Restart channel',
      channelRenderer: 'Desktop shell entry (Windows)',
      channelLaunchd: 'launchd helper (macOS)',
      channelNone: 'Unavailable',
      channelHintRenderer: 'This window calls window.dshDesktop.restartHarness() to perform the restart.',
      channelHintLaunchd: 'The Host runs dsh-restart directly; launchd reopens the app outside the process group.',
      channelHintNone: 'Neither an official entry nor a helper script exists, so no automatic restart is possible.',
      scheduled: 'Restart scheduled; handing it to the desktop shell.',
      scheduledLaunchd: 'Restart scheduled; the Host handed it to the launchd helper.',
      cancelled: 'Cancelled.',
      failed: 'failed',
      woken: 'woken',
      refused: 'refused',
      sessionRequired: 'Select a conversation to wake first.',
      busy: 'Working…',
      enabled: 'Auto-wake: on',
      disabled: 'Auto-wake: off (pending wakes need a manual trigger)',
      refresh: 'Refresh',
      onceHint: 'About 1–2 seconds after scheduling, the app restarts once. When it comes back, the selected conversation and every conversation that was mid-task receive the continue instruction.',
      wakeAll: 'Also wake every conversation that was mid-task',
      wakeAllHint: 'A restart replaces the whole process, so every interrupted conversation needs to continue in the new one. Each receives its OWN continuation, derived from what it was doing; the wake message above goes only to the conversation you selected.',
      resumable: 'Conversations needing continuation',
      resumableNone: 'No conversation is currently mid-task.',
      resumableRunning: 'agent running',
      resumableMidTurn: 'interrupted mid-turn',
      willWake: 'Will wake',
      refusedList: 'Not woken',
    }

    /** Fallback dictionaries; a Host locale binding wins when present. */
    function makeT(ctx) {
      let bound
      try {
        const candidate = ctx?.locale?.bind?.(SECTION_ID)
        if (typeof candidate === 'function') bound = candidate
      } catch {}
      return function translate(key) {
        if (bound !== undefined) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch {}
        }
        return isEnglish(ctx) ? (en[key] ?? key) : (zh[key] ?? key)
      }
    }

    function isEnglish(ctx) {
      try {
        const locale = ctx?.locale?.getLocale?.()
        const id = typeof locale === 'string' ? locale : locale?.id ?? locale?.locale
        return typeof id === 'string' && id.toLowerCase().startsWith('en')
      } catch {
        return false
      }
    }

    /** Same-origin path this package's Host half answers on. */
    const VIEW_PATH = '/api/dsh-hot-restart'

    function viewUrl() {
      try {
        return new URL(VIEW_PATH.replace(/^\//, ''), document.baseURI).pathname
      } catch {
        return VIEW_PATH
      }
    }

    /**
     * Call this package's Host half over its same-origin HTTP route.
     *
     * Deliberately not `connection.rpc.call`: the Client context has no
     * `connection` service at all, so that path is `undefined` and every panel
     * request fails before it leaves the window. A same-origin POST needs no
     * service lookup and no extra Host declaration — the Host registers the
     * route through `connection.fetch.register`.
     *
     * @param endpoint - endpoint name.
     * @param payload - JSON argument.
     * @returns the endpoint's value.
     */
    async function callHost(endpoint, payload) {
      const res = await fetch(viewUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload: payload ?? null }),
        redirect: 'error',
      })
      const result = await res.json()
      if (result === null || typeof result !== 'object') throw new Error('the Host returned an unexpected response')
      if (result.ok === false) {
        const detail = result.error ?? {}
        const reason = detail?.details?.reason
        const suffix = typeof reason === 'string' && reason.length > 0 ? ` (${reason})` : ''
        throw new Error(`${detail?.message ?? 'unknown error'}${suffix}`)
      }
      return result.value
    }

    /**
     * The conversation currently open in the main view, when it can be known.
     *
     * Settings is not scoped to a conversation, so this is a *hint* used to
     * preselect the dropdown — never the sole source of a target. The client
     * session snapshot tracks references per surface; `mainView` is the one
     * that owns the transcript.
     *
     * @param sessions - the client session snapshot, or undefined.
     * @returns a session id, or undefined.
     */
    function openConversationId(sessions) {
      if (sessions === null || typeof sessions !== 'object') return undefined
      const byId = sessions.byId
      if (byId === null || typeof byId !== 'object') return undefined
      for (const [id, entry] of Object.entries(byId)) {
        if (entry === null || typeof entry !== 'object') continue
        const retained = entry.retainedBy
        if (retained === null || typeof retained !== 'object') continue
        if (Number(retained.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /**
     * Whether this renderer can reach the official restart entry.
     *
     * This is a Windows-shell capability. The 0.2.0-rc.2 macOS build has no
     * `restartHarness` and no `harness:restart` IPC at all, so on a Mac the
     * answer is always false and the Host restarts itself through its launchd
     * helper instead. Never treat `false` here as "restart is unsupported".
     *
     * @returns true when the desktop bridge is present.
     */
    function hasRendererBridge() {
      return typeof window.dshDesktop?.restartHarness === 'function'
    }

    // --- shared renderer-side dispatch loop -------------------------------
    //
    // Exactly one loop exists per window, started by the first surface that
    // mounts. It reports which restart channel this window can drive, then
    // polls the Host for a verdict.
    //
    // The two channels split the work differently, and that is the whole point
    // of this loop:
    //   - renderer-ipc: the Host can only *ask*; this loop must call the bridge.
    //   - launchd:      the Host already ran the helper, so this loop's only job
    //                   is to have reported the bridge and then get out of the
    //                   way — calling a bridge that does not exist would just
    //                   record a bogus dispatch failure.
    //
    // Deliberately independent of whether the Settings panel is open: the wake
    // must be dispatched even if the operator navigated away after scheduling.
    const runtime = {
      started: false,
      timer: undefined,
      busy: false,
      channelReported: false,
      lastError: undefined,
    }

    /**
     * Tell the Host what this renderer can do.
     *
     * The Host runs in a different process and cannot see `window`, so without
     * this report it has to guess — and guessing wrong is exactly what makes a
     * working macOS install look broken.
     *
     * @returns the reported status, or undefined when the call failed.
     */
    async function reportChannel() {
      try {
        const reported = await callHost('note-channel', { bridge: hasRendererBridge() })
        runtime.channelReported = true
        return reported?.status
      } catch {
        // The Host may not be up yet; the next tick retries.
        return undefined
      }
    }

    async function dispatchOnce() {
      if (runtime.busy) return
      runtime.busy = true
      try {
        if (!runtime.channelReported) await reportChannel()
        const verdict = await callHost('poll', {})
        if (!verdict?.restart) return
        // Only the renderer channel asks this window to act.
        if (verdict.channel !== undefined && verdict.channel !== 'renderer-ipc') return
        if (!hasRendererBridge()) return
        // No await: the shell tears the Harness down mid-call, so the invoke
        // promise usually rejects. That rejection is expected, not a failure.
        try {
          const pending = window.dshDesktop.restartHarness()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        } catch (error) {
          await callHost('note-failure', { reason: String(error) }).catch(() => {})
        }
      } catch {
        // The Host is unreachable while it restarts; the next tick retries.
      } finally {
        runtime.busy = false
      }
    }

    function startDispatchLoop() {
      if (runtime.started) return
      runtime.started = true
      const tick = () => {
        void dispatchOnce()
        runtime.timer = setTimeout(tick, DISPATCH_MS)
        runtime.timer?.unref?.()
      }
      runtime.timer = setTimeout(tick, DISPATCH_MS)
      runtime.timer?.unref?.()
    }

    function stopDispatchLoop() {
      runtime.started = false
      if (runtime.timer !== undefined) {
        clearTimeout(runtime.timer)
        runtime.timer = undefined
      }
    }

    // --- styles ----------------------------------------------------------

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', fontSize: 13, lineHeight: 1.55 },
      header: { display: 'flex', flexDirection: 'column', gap: 3 },
      title: { fontSize: 15, fontWeight: 600 },
      subtitle: { color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '12px 14px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, wordBreak: 'break-all' },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        fontFamily: 'inherit',
        minHeight: 56,
        resize: 'vertical',
      },
      // Deliberately an OUTLINED button rather than a filled brand-colour one.
      // White-on-brand is unreadable whenever the accent is light (and the accent
      // differs per theme), which is exactly how this button "could not be seen".
      primary: {
        padding: '8px 16px',
        borderRadius: 6,
        border: '1.5px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-brand-primary)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        lineHeight: 1.2,
      },
      primaryDisabled: {
        borderColor: 'var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        cursor: 'not-allowed',
      },
      ghost: {
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      danger: {
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, whiteSpace: 'pre-wrap' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12.5 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      list: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' },
      item: {
        display: 'flex',
        gap: 8,
        fontSize: 11.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    function shortId(value) {
      if (typeof value !== 'string') return '—'
      return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
    }

    function basename(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]/u).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : value
    }

    // --- panel -----------------------------------------------------------

    function HotRestartSection(props) {
      const t = props.t
      // `useSessions` is a standard prop of a settings section, not a `ctx`
      // service. Whether the host supplies it is a per-host constant, so calling
      // it here keeps the hook order stable for the lifetime of this install.
      const sessionsSnapshot = typeof props.useSessions === 'function' ? props.useSessions((state) => state) : undefined
      const [status, setStatus] = React.useState(undefined)
      const [targets, setTargets] = React.useState([])
      const [resumable, setResumable] = React.useState([])
      const [wakeAll, setWakeAll] = React.useState(true)
      const [selected, setSelected] = React.useState('')
      const [error, setError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [reason, setReason] = React.useState('')
      const [prompt, setPrompt] = React.useState('')
      const preselected = React.useRef(false)

      const refresh = React.useCallback(async () => {
        try {
          const next = await callHost('state', {})
          setStatus(next)
          setError(undefined)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const loadTargets = React.useCallback(async () => {
        try {
          const result = await callHost('targets', {})
          const rows = Array.isArray(result?.targets) ? result.targets : []
          setTargets(rows)
          // Conversations a restart would interrupt mid-task. They are offered
          // as "wake all" so one restart resumes every running conversation
          // instead of only the one selected in the dropdown.
          try {
            const owed = await callHost('resumable', {})
            setResumable(Array.isArray(owed?.resumable) ? owed.resumable : [])
          } catch {
            setResumable([])
          }
          return rows
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return []
        }
      }, [])

      React.useEffect(() => {
        void (async () => {
          await refresh()
          const rows = await loadTargets()
          if (preselected.current) return
          preselected.current = true
          // Prefer the conversation the user is looking at, but only when the
          // Host actually reported it as a target — a stale id from another
          // window must never become the wake target by accident.
          const open = openConversationId(sessionsSnapshot)
          if (typeof open === 'string' && rows.some((row) => row.sessionId === open)) setSelected(open)
          else if (rows.length > 0) setSelected(rows[0].sessionId)
        })()
        const timer = setInterval(() => void refresh(), POLL_MS)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [refresh, loadTargets, sessionsSnapshot])

      const schedule = React.useCallback(async () => {
        if (selected === '') {
          setError(t('sessionRequired'))
          return
        }
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          // Wake-all is the default: the process is replaced once, so every
          // conversation that was mid-task must be resumed by that one restart.
          const sessionIds = wakeAll
            ? [...new Set([selected, ...resumable.map((row) => row.sessionId)].filter((id) => typeof id === 'string' && id !== ''))]
            : [selected]
          const result = await callHost('schedule', {
            // `sessionId` is the CALLER: only it receives the operator prompt.
            // It must stay set even in wake-all mode, otherwise the wording
            // above is handed to every other conversation.
            sessionId: selected,
            sessionIds: sessionIds.filter((id) => id !== selected),
            reason: reason.trim() !== '' ? reason.trim() : undefined,
            prompt: prompt.trim() !== '' ? prompt.trim() : undefined,
            requestedBy: 'settings',
          })
          const via = result?.status?.channel?.channel ?? result?.channel
          setNotice(via === 'launchd' ? t('scheduledLaunchd') : t('scheduled'))
          await refresh()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [selected, reason, prompt, refresh, t, wakeAll, resumable])

      const cancel = React.useCallback(async () => {
        setBusy(true)
        try {
          await callHost('cancel', { reason: 'cancelled from settings' })
          setNotice(t('cancelled'))
          await refresh()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [refresh, t])

      const pending = status?.pending
      const lastWake = status?.lastWake
      // The Host owns the truth about how it can be restarted: it is the one
      // that actually runs the helper. This renderer only contributes the
      // "does the official bridge exist" fact (reported through note-channel).
      const channelInfo = status?.channel
      const channelName = channelInfo?.channel
      const supported = channelName === 'renderer-ipc' || channelName === 'launchd'
      const children = []

      children.push(
        h('div', { key: 'header', style: styles.header }, [
          h('div', { key: 'title', style: styles.title }, t('title')),
          h('div', { key: 'subtitle', style: styles.subtitle }, t('subtitle')),
        ]),
      )

      if (!supported && status !== undefined) {
        children.push(h('div', { key: 'unsupported', style: styles.error }, t('unsupported')))
      }

      // The channel card is not decoration: on macOS the official entry does
      // not exist, and without this row the panel's silence reads as "broken".
      if (channelInfo !== undefined && channelInfo !== null) {
        const label =
          channelName === 'renderer-ipc'
            ? t('channelRenderer')
            : channelName === 'launchd'
              ? t('channelLaunchd')
              : t('channelNone')
        const hint =
          channelName === 'renderer-ipc'
            ? t('channelHintRenderer')
            : channelName === 'launchd'
              ? t('channelHintLaunchd')
              : t('channelHintNone')
        children.push(
          h('div', { key: 'channel', style: styles.card }, [
            h('div', { key: 'title', style: styles.cardTitle }, t('channel')),
            h('div', { key: 'label', style: styles.value }, label),
            h('div', { key: 'hint', style: styles.muted }, hint),
            channelInfo.script !== null && channelInfo.script !== undefined
              ? h('div', { key: 'script', style: styles.value }, channelInfo.script)
              : null,
          ]),
        )
      }

      const options = []
      options.push(h('option', { key: '__empty', value: '' }, t('targetPlaceholder')))
      const openId = openConversationId(sessionsSnapshot)
      for (const row of targets) {
        const label = [
          row.title ?? shortId(row.sessionId),
          row.cwd !== undefined ? `· ${basename(row.cwd)}` : '',
          row.sessionId === openId ? `· ${t('targetCurrent')}` : '',
        ]
          .filter(Boolean)
          .join(' ')
        options.push(h('option', { key: row.sessionId, value: row.sessionId }, label))
      }

      children.push(
        h('div', { key: 'target', style: styles.card }, [
          h('div', { key: 'title', style: styles.cardTitle }, t('target')),
          targets.length === 0
            ? h('div', { key: 'empty', style: styles.muted }, t('targetEmpty'))
            : h(
                'select',
                {
                  key: 'pick',
                  style: styles.select,
                  value: selected,
                  onChange: (event) => setSelected(event.target.value),
                },
                options,
              ),
          h('div', { key: 'hint', style: styles.muted }, t('targetHint')),
        ]),
      )

      children.push(
        h('div', { key: 'form', style: styles.card }, [
          h('div', { key: 'reasonTitle', style: styles.cardTitle }, t('reason')),
          h('input', {
            key: 'reason',
            style: styles.input,
            value: reason,
            placeholder: t('reasonPlaceholder'),
            onChange: (event) => setReason(event.target.value),
          }),
          h('div', { key: 'promptTitle', style: styles.cardTitle }, t('prompt')),
          h('textarea', {
            key: 'prompt',
            style: styles.textarea,
            value: prompt,
            placeholder: t('promptPlaceholder'),
            onChange: (event) => setPrompt(event.target.value),
          }),
          // Wake-all defaults on: one restart replaces the process, so every
          // conversation it interrupts has to be resumed by that same restart.
          h('label', { key: 'wakeAll', style: styles.row }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: wakeAll,
              onChange: (event) => setWakeAll(event.target.checked),
            }),
            h('span', { key: 'label', style: styles.value }, t('wakeAll')),
          ]),
          h('div', { key: 'wakeAllHint', style: styles.muted }, t('wakeAllHint')),
          wakeAll && resumable.length > 0
            ? h(
                'ul',
                { key: 'resumable', style: styles.list },
                resumable.map((row) =>
                  h(
                    'li',
                    { key: row.sessionId, style: styles.item },
                    `${row.title ?? row.sessionId} · ${
                      row.reason === 'agent-running' ? t('resumableRunning') : t('resumableMidTurn')
                    }`,
                  ),
                ),
              )
            : null,
          h('div', { key: 'hint', style: styles.muted }, t('onceHint')),
          h('div', { key: 'actions', style: styles.row }, [
            h(
              'button',
              {
                key: 'schedule',
                type: 'button',
                style: styles.primary,
                disabled: busy || !supported || selected === '',
                onClick: () => void schedule(),
              },
              busy ? t('busy') : t('schedule'),
            ),
            pending !== null && pending !== undefined
              ? h('button', { key: 'cancel', type: 'button', style: styles.danger, disabled: busy, onClick: () => void cancel() }, t('cancel'))
              : null,
            h('button', { key: 'refresh', type: 'button', style: styles.ghost, disabled: busy, onClick: () => void refresh() }, t('refresh')),
          ]),
        ]),
      )

      if (notice !== undefined) children.push(h('div', { key: 'notice', style: styles.ok }, notice))
      if (error !== undefined) children.push(h('div', { key: 'error', style: styles.error }, `${t('failed')}: ${error}`))

      // Show every owed conversation, not just the first: a restart that wakes
      // several is the normal case, and hiding the rest would misreport it.
      const pendingList = Array.isArray(status?.pendingWakes)
        ? status.pendingWakes
        : pending !== null && pending !== undefined
          ? [pending]
          : []
      children.push(
        h('div', { key: 'state', style: styles.card }, [
          h('div', { key: 'title', style: styles.cardTitle }, `${t('pending')}${pendingList.length > 1 ? ` (${pendingList.length})` : ''}`),
          pendingList.length > 0
            ? h(
                'div',
                { key: 'pendingBody', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                pendingList.map((entry) =>
                  h('div', { key: entry.sessionId, style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
                    h('div', { key: 'id', style: styles.value }, entry.sessionId),
                    h('div', { key: 'wake', style: styles.muted }, `wake ${shortId(entry.wakeId)}`),
                    entry.archived
                      ? h('div', { key: 'arch', style: styles.error }, 'archived — the wake will be refused')
                      : null,
                  ]),
                ),
              )
            : h('div', { key: 'none', style: styles.muted }, t('noPending')),
        ]),
      )

      if (lastWake !== null && lastWake !== undefined) {
        children.push(
          h('div', { key: 'last', style: styles.card }, [
            h('div', { key: 'title', style: styles.cardTitle }, t('lastWake')),
            h(
              'div',
              { key: 'result', style: lastWake.ok ? styles.ok : styles.error },
              `${lastWake.ok ? t('woken') : t('refused')} · ${lastWake.reason ?? ''}`,
            ),
            h('div', { key: 'session', style: styles.value }, lastWake.sessionId ?? '—'),
            lastWake.message !== undefined ? h('div', { key: 'msg', style: styles.muted }, String(lastWake.message)) : null,
            h('div', { key: 'time', style: styles.muted }, formatTime(lastWake.at)),
          ]),
        )
      }

      const history = Array.isArray(status?.history) ? status.history.slice(0, 8) : []
      if (history.length > 0) {
        children.push(
          h('div', { key: 'history', style: styles.card }, [
            h('div', { key: 'title', style: styles.cardTitle }, t('history')),
            h(
              'ul',
              { key: 'list', style: styles.list },
              history.map((entry, index) =>
                h(
                  'li',
                  { key: `${entry.at ?? index}-${index}`, style: styles.item },
                  `${formatTime(entry.at)}  ${entry.kind ?? '?'}${entry.reason ? ` (${entry.reason})` : ''}`,
                ),
              ),
            ),
          ]),
        )
      }

      children.push(
        h('div', { key: 'boot', style: styles.card }, [
          h('div', { key: 'title', style: styles.cardTitle }, t('boot')),
          h('div', { key: 'bootId', style: styles.value }, shortId(status?.bootId)),
          h('div', { key: 'prev', style: styles.muted }, `${t('previousBoot')}: ${shortId(status?.previousBootId)}`),
          h('div', { key: 'auto', style: styles.muted }, status?.autoWake === false ? t('disabled') : t('enabled')),
          h('div', { key: 'ledger', style: styles.value }, status?.ledgerPath ?? '—'),
        ]),
      )

      return h('div', { style: styles.root }, children)
    }

    // --- install ---------------------------------------------------------

    function apply(ctx) {
      const t = makeT(ctx)

      // The dispatch loop must run for the whole window lifetime, not just while
      // Settings is open: a scheduled restart has to fire even if the operator
      // closed the panel.
      startDispatchLoop()
      ctx.effect(() => () => stopDispatchLoop(), 'dsh-hot-restart: dispatch loop')

      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register(
            {
              name: 'settings.section',
              // A fresh id adds a section beside the shipped ones; reusing a
              // shipped id would replace that page.
              id: SECTION_ID,
              order: 45,
              label: () => t('nav'),
            },
            (props) =>
              h(HotRestartSection, {
                ...props,
                t,
                ctx,
              }),
          )
        } catch (error) {
          // A failed registration must cost this plugin's page only, never the
          // whole settings UI.
          console.error('[dsh-hot-restart] settings section registration failed:', error)
          return () => {}
        }
      })
    }

    const inject = ['slots']

    exports.SECTION_ID = SECTION_ID
    exports.dictionary = zh
    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})
