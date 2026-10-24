/**
 * Pure helpers for dsh-hot-restart.
 *
 * Nothing here touches the filesystem, the Cordis context, or the clock, so
 * every guard that answers "may I wake this session?" is unit-testable without
 * booting a Harness.
 *
 * @module dsh-hot-restart/pure
 */

/** On-disk ledger schema version. Bump when the shape changes incompatibly. */
export const LEDGER_SCHEMA = 2

/**
 * The one-line marker embedded in every wake message.
 *
 * This is what makes a wake replay-safe: before delivering, the engine scans
 * the session log for this exact token, so a crash between "sent" and "recorded
 * as sent" cannot wake the same session twice.
 *
 * @param wakeId - unique wake identity.
 * @returns the marker substring.
 */
export function wakeMarker(wakeId) {
  return `[[dsh-hot-restart wake=${wakeId}]]`
}

/**
 * Build the message text a woken session receives.
 *
 * Deliberately bilingual-free and short: it is read by a model, not a human,
 * and it has to survive being the only user message in a fresh process.
 *
 * @param input - wake identity, target session, and optional operator reason.
 * @returns message text that always carries the wake marker.
 */
export function buildWakeText(input) {
  const { wakeId, sessionId, reason, prompt, previousBoot } = input
  const lines = [wakeMarker(wakeId), '']
  // The framing lines are NOT conditional on the operator supplying a prompt.
  // A custom prompt used to replace them, which is how a wake could arrive with
  // no statement that a restart had happened at all — leaving the agent to
  // mistake it for a fresh message and start over.
  lines.push('【热重启完成】DSH 宿主进程已重启，你现在运行在新进程里，本对话是重启前那次工作的延续。')
  if (typeof prompt === 'string' && prompt.trim() !== '') {
    lines.push('')
    lines.push(prompt.trim())
  } else {
    lines.push('上一轮工作被进程重启打断，请从上次中断处继续未完成的任务；若已经完成，只做简短汇报即可。')
  }
  lines.push('')
  lines.push(`会话：${sessionId}`)
  if (typeof previousBoot === 'string' && previousBoot !== '') lines.push(`上一个宿主进程：${previousBoot}`)
  if (typeof reason === 'string' && reason.trim() !== '') lines.push(`重启原因：${reason.trim()}`)
  return lines.join('\n')
}

/**
 * Summarize the last real user request in a session log.
 *
 * This is what makes a per-conversation resume message possible: the agent in
 * that conversation needs to be reminded of *its own* task, not handed another
 * conversation's instructions.
 *
 * @param events - the session event log.
 * @returns the latest genuine user text, trimmed and clipped, or undefined.
 */
export function lastUserRequest(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isPlainObject(event) || event.type !== 'user/message') continue
    const data = event.data
    if (!isPlainObject(data)) continue
    const source = data.source
    // Plugin-injected context (memory snapshots, instructions, tool results)
    // is not a request from the person; only `user` messages are.
    if (!isPlainObject(source) || source.kind !== 'user') continue
    const text = contentText(data.content)
    if (text === '') continue
    // A previous WAKE is also a user-role message, but it is not a request from
    // the person — it is this plugin's own earlier continuation. Feeding it
    // back produces a wake message that quotes an older wake message.
    if (isWakeText(text)) continue
    return clip(text, 400)
  }
  return undefined
}

/**
 * Is this text one of our own wake messages?
 * @param text - message body.
 * @returns true when it carries the wake marker.
 */
export function isWakeText(text) {
  if (typeof text !== 'string') return false
  // Only a message that OPENS with the marker is one of our wakes. A person (or
  // a review note) may quote the marker mid-sentence; treating that as a wake
  // would silently drop a real request — the opposite failure.
  return /^\s*\[\[dsh-hot-restart wake=[^\]]*\]\]/.test(text)
}

/**
 * The last thing the agent was doing when the restart cut it off.
 * @param events - the session event log.
 * @returns a short description of the final tool call or assistant text.
 */
export function lastActivity(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isPlainObject(event)) continue
    if (event.type === 'tool/call') {
      const name = typeof event.data?.name === 'string' ? event.data.name : 'a tool'
      return `正在调用 ${name}`
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isPlainObject(block)) continue
        if (block.type === 'tool-call' && typeof block.name === 'string') return `正在调用 ${block.name}`
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          return `刚说完：「${clip(block.text.trim(), 120)}」`
        }
      }
    }
    if (event.type === 'step/start') {
      const step = event.data?.step
      if (Number.isFinite(step)) return `做到第 ${step} 步`
    }
  }
  return undefined
}

/**
 * Build the continuation instructions for ONE conversation.
 *
 * Every conversation gets its own message, derived from its own log tail. This
 * is the fix for a real incident: the caller's prompt ("verify these three
 * things") was copied to an unrelated conversation, which then abandoned its
 * own task to go verify somebody else's.
 *
 * @param events - that conversation's event log.
 * @param sessionId - the conversation id, for the trace line.
 * @returns `{ prompt, source }` where source names how it was derived.
 */
export function buildResumePrompt(events, sessionId) {
  const request = lastUserRequest(events)
  const activity = lastActivity(events)
  const lines = ['【本对话的续接指令】这不是一条新消息：进程重启打断了你原来的工作，请接着做下面这件事。']
  if (request !== undefined) {
    lines.push('')
    lines.push(`你在这轮对话里正在处理：${request}`)
  }
  // "you were calling hot_restart" is self-referential noise: that call is the
  // restart itself, not the work being resumed.
  if (activity !== undefined && !/hot_restart/.test(activity)) {
    lines.push(`中断时你${activity}。`)
  }
  lines.push('')
  lines.push('请直接从上次中断的地方继续，不要重新开始、不要复述计划、不要等待新的指示。')
  // The session id is appended by buildWakeText; repeating it here would print
  // the same id twice in one message.
  return {
    prompt: lines.join('\n'),
    source: request === undefined ? 'derived-activity' : 'derived-last-request',
  }
}

/**
 * A fresh ledger for the current boot.
 * @param bootId - identity of the running Host process.
 * @param now - epoch milliseconds.
 * @returns a ledger object with no pending work.
 */
export function createLedger(bootId, now = Date.now()) {
  return {
    schema: LEDGER_SCHEMA,
    bootId,
    bootedAt: now,
    previousBootId: null,
    previousBootedAt: null,
    restart: null,
    // A single restart wakes EVERY owed conversation, so the durable record is
    // a list. `pending` is kept as a read-only alias of the first entry so an
    // older panel build and the pre-multi-session ledger both keep working.
    pending: null,
    pendingWakes: [],
    lastWake: null,
    history: [],
  }
}

/**
 * Normalize the wake list, accepting the pre-multi-session single record.
 *
 * A ledger written by an older build has `pending: {...}` and no list. That
 * wake is still owed, so it is promoted into the list instead of dropped:
 * upgrading the plugin must never silently cancel an in-flight restart.
 *
 * @param raw - parsed ledger content.
 * @returns the owed wakes, de-duplicated by session id.
 */
export function normalizePendingWakes(raw) {
  const list = []
  const push = (candidate) => {
    if (!isPlainObject(candidate)) return
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
    if (sessionId === '') return
    if (list.some((entry) => entry.sessionId === sessionId)) return
    list.push({ ...candidate })
  }
  if (Array.isArray(raw?.pendingWakes)) for (const candidate of raw.pendingWakes) push(candidate)
  push(raw?.pending)
  return list
}

/**
 * Coerce whatever was on disk into a usable ledger for this boot.
 *
 * The invariant that matters: `pending` and `restart` survive a reboot, while
 * `previousBootId` records whose ledger this was. `bootId`/`bootedAt` are
 * always overwritten with the live process identity, so "written by a previous
 * boot" is a fact that can be read rather than inferred.
 *
 * @param raw - parsed ledger file content, or undefined.
 * @param bootId - identity of the running Host process.
 * @param now - epoch milliseconds.
 * @returns the normalized ledger.
 */
export function normalizeLedger(raw, bootId, now = Date.now()) {
  const ledger = createLedger(bootId, now)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ledger
  ledger.previousBootId = typeof raw.bootId === 'string' ? raw.bootId : null
  ledger.previousBootedAt = Number.isFinite(raw.bootedAt) ? raw.bootedAt : null
  ledger.restart = isPlainObject(raw.restart) ? { ...raw.restart } : null
  const pendingWakes = normalizePendingWakes(raw)
  ledger.pendingWakes = pendingWakes
  ledger.pending = pendingWakes[0] ?? null
  ledger.lastWake = isPlainObject(raw.lastWake) ? { ...raw.lastWake } : null
  ledger.history = Array.isArray(raw.history) ? raw.history.filter(isPlainObject).slice(0, 200) : []
  return ledger
}

/**
 * Decide whether a pending wake is owed to a *different* boot.
 *
 * A wake is owed only to a boot that is not the one that scheduled it. When the
 * scheduling boot still holds the record, the restart it asked for has not
 * happened yet, so delivering now would "wake" the very conversation that is
 * still alive — a wake with no restart behind it, which is exactly the failure
 * mode this guard exists to prevent.
 *
 * @param pending - the ledger's pending wake.
 * @param bootId - the current boot id.
 * @returns true when this boot must deliver the wake.
 */
export function wakeOwedToAnotherBoot(pending, bootId) {
  if (!isPlainObject(pending)) return false
  if (typeof pending.previousBootId !== 'string') return true
  return pending.previousBootId !== bootId
}

/**
 * The subset of owed wakes this boot must deliver.
 * @param pendingWakes - the ledger's wake list.
 * @param bootId - the current boot id.
 * @returns the wakes still owed to this boot.
 */
export function wakesOwedToAnotherBoot(pendingWakes, bootId) {
  if (!Array.isArray(pendingWakes)) return []
  return pendingWakes.filter((pending) => wakeOwedToAnotherBoot(pending, bootId))
}

/**
 * Does a session log end mid-turn, i.e. was work cut off by the restart?
 *
 * A turn that opened (`turn/start`) without a matching `turn/end` is exactly
 * the signature of a process that died while an agent was working. That is the
 * case where the conversation must be resumed rather than left alone.
 *
 * @param events - the session event log.
 * @returns true when the log ends inside an open turn.
 */
export function sessionEndsMidTurn(events) {
  if (!Array.isArray(events)) return false
  let open = false
  for (const event of events) {
    if (!isPlainObject(event)) continue
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * Capture the identity fields a wake is allowed to target.
 *
 * Sessions carry no stable title the fingerprint could rely on, so the
 * fingerprint is the header itself: identity, directory, creation instant,
 * lineage. A different session cannot forge all four, and a re-created session
 * with the same id (fork/import) changes `createdAt`.
 *
 * @param observation - a Host session observation.
 * @returns the durable fingerprint subset.
 */
export function fingerprintOf(observation) {
  const header = observation?.header ?? observation?.meta ?? {}
  return {
    sessionId: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    origin: header.origin,
    parentSession: header.parentSession,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
  }
}

/**
 * Decide whether a pending wake may target the observed session.
 *
 * Every rejection names a distinct reason so the audit trail explains itself
 * after the fact. This is the single function standing between "wake the
 * session the user meant" and "wake somebody else's conversation".
 *
 * @param pending - the ledger's pending wake.
 * @param observation - the session as it currently exists on disk.
 * @param archivedIds - session ids archived by the workspace registry.
 * @returns `{ ok: true }` or `{ ok: false, reason, detail }`.
 */
export function checkFingerprint(pending, observation, archivedIds = []) {
  if (!isPlainObject(pending)) return reject('no-pending-wake')
  const sessionId = typeof pending.sessionId === 'string' ? pending.sessionId : ''
  if (sessionId === '') return reject('pending-wake-has-no-session')
  const fingerprint = fingerprintOf(observation)
  if (typeof fingerprint.sessionId !== 'string' || fingerprint.sessionId === '') {
    return reject('observation-has-no-session', { observed: fingerprint.sessionId })
  }
  if (fingerprint.sessionId !== sessionId) {
    return reject('session-id-mismatch', { expected: sessionId, observed: fingerprint.sessionId })
  }
  if (fingerprint.origin === 'subagent') return reject('subagent-session')
  if (archivedIds.includes(sessionId)) return reject('session-archived')
  if (pending.cwd !== undefined && fingerprint.cwd !== pending.cwd) {
    return reject('cwd-mismatch', { expected: pending.cwd, observed: fingerprint.cwd })
  }
  if (pending.createdAt !== undefined && fingerprint.createdAt !== pending.createdAt) {
    return reject('created-at-mismatch', { expected: pending.createdAt, observed: fingerprint.createdAt })
  }
  return { ok: true, fingerprint }
}

/**
 * Has this wake already landed in the session log?
 *
 * Two independent signals are accepted: the durable `rpcId` the message was
 * submitted with, and the wake marker inside the message text. Either one
 * proves delivery, so an interrupted acknowledgement cannot cause a double
 * wake.
 *
 * @param events - the session event log.
 * @param wakeId - wake identity.
 * @param requestId - the durable prompt identity the wake was sent with.
 * @returns the matching event, or undefined.
 */
export function findWakeDelivery(events, wakeId, requestId) {
  if (!Array.isArray(events)) return undefined
  const marker = wakeMarker(wakeId)
  for (const event of events) {
    if (!isPlainObject(event)) continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (!isPlainObject(data)) continue
    const source = data.source
    if (requestId !== undefined && isPlainObject(source) && source.rpcId === requestId) return event
    if (marker !== '' && containsText(data.content, marker)) return event
  }
  return undefined
}

/**
 * Collapse a session observation into the small record the ledger keeps.
 * @param observation - a Host session observation.
 * @param requestId - durable prompt identity allocated for this wake.
 * @param reason - operator reason, if any.
 * @returns the pending-wake record.
 */
export function pendingFromObservation(observation, requestId, reason) {
  const fingerprint = fingerprintOf(observation)
  return {
    wakeId: requestId,
    requestId,
    sessionId: fingerprint.sessionId,
    cwd: fingerprint.cwd,
    createdAt: fingerprint.createdAt,
    origin: fingerprint.origin,
    agentPreset: fingerprint.agentPreset,
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : undefined,
  }
}

/**
 * Turn a restart request into a ledger `restart` record.
 * @param wakeId - the wake this restart serves.
 * @param now - epoch milliseconds.
 * @param requestedBy - who asked (panel, tool, api).
 * @returns the restart record.
 */
export function createRestartRequest(wakeId, now = Date.now(), requestedBy = 'panel') {
  return { wakeId, requestedAt: now, requestedBy, attempts: 0, lastAttemptAt: null, dispatchedAt: null }
}

/**
 * The restart channels this plugin knows how to drive, in preference order.
 *
 * `renderer-ipc` is the official Desktop entry (`window.dshDesktop.restartHarness`).
 * It exists on the Windows desktop shell; the macOS 0.2.0-rc.2 build ships no
 * such bridge at all — searching its `app.asar` for `restartHarness` or
 * `harness:restart` yields zero hits — so a plugin that only knows the IPC path
 * is dead on arrival on a Mac.
 *
 * `launchd` is the macOS fallback: a helper script re-execs the app through
 * launchd, which survives the process-group teardown that kills anything
 * started from inside the app.
 */
export const RESTART_CHANNEL = {
  rendererIpc: 'renderer-ipc',
  launchd: 'launchd',
  none: 'none',
}

/**
 * Which channel can actually restart this Host.
 *
 * @param input - what the caller could observe.
 * @param input.hasRendererBridge - whether `window.dshDesktop.restartHarness` exists.
 * @param input.hasRestartScript - whether a launchd helper script was found.
 * @returns the channel to use.
 */
export function pickRestartChannel({ hasRendererBridge = false, hasRestartScript = false } = {}) {
  if (hasRendererBridge) return RESTART_CHANNEL.rendererIpc
  if (hasRestartScript) return RESTART_CHANNEL.launchd
  return RESTART_CHANNEL.none
}

/**
 * Decide whether the desktop shell should call `restartHarness()` right now.
 *
 * A dispatch is due while the request is fresh and under the attempt cap. Once
 * a dispatch has been recorded the shell is expected to die; if it does not
 * (the restart threw), the next tick may retry after the retry window.
 *
 * @param restart - the ledger's restart record.
 * @param now - epoch milliseconds.
 * @param options - freshness window, attempt cap, retry backoff.
 * @returns `{ due: boolean, reason?: string }`.
 */
export function restartDispatchDue(restart, now = Date.now(), options = {}) {
  const { ttlMs = 60_000, maxAttempts = 3, retryMs = 20_000 } = options
  if (!isPlainObject(restart)) return { due: false, reason: 'no-restart-request' }
  if (!Number.isFinite(restart.requestedAt)) return { due: false, reason: 'restart-request-has-no-timestamp' }
  const age = now - restart.requestedAt
  if (age > ttlMs) return { due: false, reason: 'restart-request-expired' }
  const attempts = Number.isFinite(restart.attempts) ? restart.attempts : 0
  if (attempts >= maxAttempts) return { due: false, reason: 'restart-attempts-exhausted' }
  if (attempts > 0) {
    const sinceLast = Number.isFinite(restart.lastAttemptAt) ? now - restart.lastAttemptAt : Infinity
    if (sinceLast < retryMs) return { due: false, reason: 'restart-retry-backoff' }
  }
  return { due: true }
}

/**
 * Append one audit/history entry, keeping the ledger bounded.
 * @param ledger - ledger to mutate.
 * @param entry - the record to append.
 * @param limit - maximum retained entries.
 * @returns the ledger.
 */
export function pushHistory(ledger, entry, limit = 20) {
  const history = Array.isArray(ledger.history) ? ledger.history : []
  history.unshift({ at: Date.now(), ...entry })
  ledger.history = history.slice(0, Math.max(1, limit))
  return ledger
}

/**
 * Whether a restart record may be cleared as abandoned.
 * @param restart - the ledger's restart record.
 * @param now - epoch milliseconds.
 * @param ttlMs - freshness window.
 * @returns true when nothing is owed any more.
 */
export function restartIsStale(restart, now = Date.now(), ttlMs = 60_000) {
  if (!isPlainObject(restart)) return true
  if (!Number.isFinite(restart.requestedAt)) return true
  return now - restart.requestedAt > ttlMs
}

/**
 * Whether a session id looks like one this plugin may target.
 *
 * Subagent ids are generated by the same factory as ordinary ones, so this is
 * a shape check only; the real `origin` guard lives in {@link checkFingerprint}.
 *
 * @param value - candidate id.
 * @returns true when the string is a plausible session id.
 */
export function isSessionIdLike(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_:.-]{8,128}$/.test(value.trim())
}

/**
 * Read the visible text out of a message's content.
 * @param content - a string or an array of content blocks.
 * @returns the joined text, or an empty string.
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (isPlainObject(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Bound a string to a character budget.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns the text, ellipsized when it overflows.
 */
function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function containsText(content, needle) {
  if (typeof content === 'string') return content.includes(needle)
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!isPlainObject(block)) continue
    if (typeof block.text === 'string' && block.text.includes(needle)) return true
  }
  return false
}

function reject(reason, detail) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
