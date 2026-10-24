/**
 * The hot-restart engine: durable ledger, restart scheduling, and the wake that
 * resumes exactly one conversation after the Host process comes back.
 *
 * Design notes that matter for correctness:
 *
 * - The restart itself is never performed here. A renderer (which satisfies the
 *   Desktop shell's `event.sender === mainWindow.webContents` check) calls
 *   `window.dshDesktop.restartHarness()`. This module only says *when*.
 * - The wake is deliberately conservative: the ledger records a fingerprint of
 *   the target session, and the wake refuses to run unless the session that
 *   exists on disk still matches that fingerprint. Anything ambiguous fails
 *   closed, because waking the wrong conversation is worse than not waking.
 * - Delivery is replay-safe. The wake marker lives in the message text, so a
 *   crash between "delivered" and "recorded as delivered" cannot double-wake.
 *
 * @module dsh-hot-restart/core
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  buildResumePrompt,
  buildWakeText,
  checkFingerprint,
  createLedger,
  createRestartRequest,
  findWakeDelivery,
  normalizeLedger,
  pendingFromObservation,
  pushHistory,
  restartDispatchDue,
  restartIsStale,
  sessionEndsMidTurn,
  wakeMarker,
  wakeOwedToAnotherBoot,
  wakesOwedToAnotherBoot,
} from './pure.js'
import { readJsonFile, writeJsonAtomic } from './fsutil.js'
import { RestartChannel } from './channel.js'

/** Ledger file name inside the data directory. */
export const LEDGER_FILE = 'ledger.json'

/**
 * Error raised for anything the operator must fix.
 */
export class HotRestartError extends Error {
  /**
   * @param code - stable machine-readable reason.
   * @param message - human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HotRestartError'
    this.code = code
  }
}

/**
 * Owns one Host process's view of the restart ledger.
 */
export class HotRestart {
  /**
   * @param options - wiring for this instance.
   * @param options.ctx - the Cordis context.
   * @param options.logger - optional logger.
   * @param options.dataDir - directory that holds the ledger.
   * @param options.config - normalized plugin configuration.
   * @param options.createUserMessage - optional message factory override.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.config = options.config
    this.dataDir = options.dataDir
    this.injectedCreateUserMessage = options.createUserMessage
    this.ledgerPath = join(options.dataDir, LEDGER_FILE)
    this.bootId = randomBytes(8).toString('hex')
    this.ledger = createLedger(this.bootId)
    this.wakeInFlight = undefined
    // Per-session attempt counts: several conversations can be owed one wake.
    this.wakeAttemptsBySession = new Map()
    this.disposed = false
    this.timer = undefined
    // Which mechanism can restart this Host. On macOS this is the launchd
    // helper, because the Mac shell exposes no restart IPC at all.
    this.channel = options.channel ?? new RestartChannel({ logger: this.logger, scripts: options.restartScripts })
  }

  /**
   * Load the ledger and take ownership of it for this boot.
   *
   * A restart record that already carries an attempt was written by a boot that
   * is now gone: the dispatch it asked for is what brought us here. Keeping it
   * would make this boot dispatch another restart, forever.
   *
   * @returns the normalized ledger.
   */
  load() {
    const raw = readJsonFile(this.ledgerPath, undefined)
    const ledger = normalizeLedger(raw, this.bootId)
    if (ledger.restart !== null && Number(ledger.restart.attempts ?? 0) > 0) {
      pushHistory(ledger, {
        kind: 'restart-completed',
        wakeId: ledger.restart.wakeId,
        at: ledger.restart.lastAttemptAt ?? Date.now(),
      })
      ledger.restart = null
    }
    this.ledger = ledger
    this.save()
    return ledger
  }

  /**
   * Persist the ledger atomically.
   *
   * Callers that are about to kill the process must treat a throw here as
   * fatal to the request: a restart whose intent never reached disk loses the
   * wake, which is worse than not restarting at all.
   */
  save() {
    writeJsonAtomic(this.ledgerPath, this.ledger)
  }

  /**
   * Everything the panel needs, and nothing it does not.
   * @returns a serializable status snapshot.
   */
  status() {
    const archived = this.archivedSessionIds()
    const pendingWakes = Array.isArray(this.ledger.pendingWakes) ? this.ledger.pendingWakes : []
    const pending = pendingWakes[0] ?? null
    return {
      bootId: this.bootId,
      bootedAt: this.ledger.bootedAt,
      previousBootId: this.ledger.previousBootId,
      previousBootedAt: this.ledger.previousBootedAt,
      dataDir: this.dataDir,
      ledgerPath: this.ledgerPath,
      autoWake: this.config.autoWake,
      pending: pending === null ? null : { ...pending, archived: archived.includes(pending.sessionId) },
      // Every conversation this restart owes, so the panel can show all of them
      // rather than only the first one.
      pendingWakes: pendingWakes.map((entry) => ({ ...entry, archived: archived.includes(entry.sessionId) })),
      restart: this.ledger.restart,
      lastWake: this.ledger.lastWake,
      history: this.ledger.history,
      wakeInFlight: this.wakeInFlight !== undefined,
      attempts: this.attemptsFor(pending?.sessionId ?? ''),
      channel: this.channel.describe(),
    }
  }

  /**
   * Archive set from the workspace registry, when the Host provides one.
   * @returns archived session ids.
   */
  archivedSessionIds() {
    const registry = this.ctx.get?.('workspaceRegistry')
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? ids : []
  }

  /**
   * List conversations the panel may target.
   *
   * The settings page is not scoped to a conversation the way the sidebar is,
   * so it has to offer a choice. Everything here is advisory: the fingerprint
   * check still runs at wake time, and a session that disappears or changes in
   * between is refused rather than guessed at.
   *
   * @param limit - maximum entries returned.
   * @returns summarized conversations, newest first.
   */
  async listTargets(limit = 40) {
    const query = this.ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') return []
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      this.logger?.warn?.(`could not list sessions for the panel: ${String(error)}`)
      return []
    }
    if (!Array.isArray(records)) return []
    const archived = new Set(this.archivedSessionIds())
    const rows = []
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue
      // `sessionQuery.listSessions()` returns `{ header, live, persisted }`, so
      // the identity fields live under `header`. Reading them off the wrapper
      // (as an earlier build did) silently produced an empty target list.
      const header = record.header !== null && typeof record.header === 'object' ? record.header : record
      const id = typeof header.id === 'string' ? header.id : typeof record.sessionId === 'string' ? record.sessionId : ''
      if (id === '') continue
      // Subagent sessions are not user conversations; offering them would invite
      // exactly the wake this plugin exists to refuse.
      if (header.origin === 'subagent' || record.origin === 'subagent') continue
      if (archived.has(id)) continue
      rows.push({
        sessionId: id,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : undefined,
        title:
          typeof record.title === 'string' && record.title !== ''
            ? record.title
            : typeof header.title === 'string' && header.title !== ''
              ? header.title
              : undefined,
        agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
        live: record.live === true,
      })
    }
    rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    return rows.slice(0, Math.max(1, limit))
  }

  /**
   * Every conversation that should be resumed after this restart.
   *
   * Two disjoint sets qualify:
   *
   * 1. **Interrupted mid-task** — a live agent that is still running, or a
   *    stored log that ends inside an open turn. The restart cut its work off.
   * 2. **Open but idle** — a conversation the operator still has open (it is
   *    live in this Host) whose turn had already finished. It is not stranded,
   *    but the operator's expectation is "every conversation I had open comes
   *    back and keeps working", and a restart that silently drops the idle ones
   *    looks exactly like the bug this plugin exists to fix: you can only
   *    continue one of the two conversations you were running.
   *
   * Set `wakeIdle: false` to get the old mid-task-only behaviour.
   *
   * @param limit - maximum conversations returned.
   * @returns resumable conversations, newest first, with the reason each qualified.
   */
  async listResumable(limit = 20) {
    const candidates = await this.listTargets(Math.max(limit * 4, 40))
    const running = this.liveAgentIds()
    const rows = []
    for (const candidate of candidates) {
      const id = candidate.sessionId
      if (running.has(id)) {
        rows.push({ ...candidate, reason: 'agent-running' })
        continue
      }
      // A persisted conversation has to be inspected to see whether its log
      // ends inside an open turn; a live one with no running agent has already
      // finished its turn (otherwise its agent would still be listed).
      let observation
      try {
        observation = await this.observe(id)
      } catch (error) {
        this.logger?.warn?.(`could not inspect session ${id}: ${String(error)}`)
        continue
      }
      if (observation === undefined) continue
      if (sessionEndsMidTurn(observation.events)) {
        rows.push({ ...candidate, reason: 'ended-mid-turn' })
        continue
      }
      // Idle but open: still owed a wake so the operator's other conversations
      // keep working instead of being stranded at their last finished turn.
      if (candidate.live === true && this.config.wakeIdle !== false) {
        rows.push({ ...candidate, reason: 'open-idle' })
      }
    }
    return rows.slice(0, Math.max(1, limit))
  }

  /**
   * Ids of agents this Host currently has running.
   *
   * Uses the same agent/session id space, so a live agent id is directly
   * comparable with a session id.
   *
   * @returns the running agent ids.
   */
  liveAgentIds() {
    const agents = this.ctx.get?.('agents')
    if (agents === undefined || typeof agents.list !== 'function') return new Set()
    const ids = new Set()
    try {
      for (const agent of agents.list()) {
        if (agent === null || typeof agent !== 'object') continue
        if (agent.status !== 'running') continue
        if (typeof agent.id === 'string') ids.add(agent.id)
      }
    } catch {}
    return ids
  }

  /**
   * Schedule a restart of the Host process that will wake every named session.
   *
   * One restart can owe wakes to several conversations: the process is replaced
   * once, and every conversation that was mid-task must be resumed in the new
   * process. Each observation is taken *now* while the sessions are certainly
   * live, so every fingerprint records the conversation as it was selected.
   *
   * @param input - target sessions and operator intent.
   * @param input.sessionId - one exact session to wake (legacy single form).
   * @param input.sessionIds - every exact session to wake.
   * @param input.allConversations - also wake every conversation found
   *   mid-task. Defaults to true; `false` restricts the wake to the named set.
   * @param input.reason - why the restart was requested.
   * @param input.prompt - replacement wake instructions.
   * @param input.requestedBy - which surface asked.
   * @returns the pending records and the restart record.
   */
  async scheduleRestart(input) {
    if (this.disposed) throw new HotRestartError('disposed', 'the plugin is shutting down')
    const requested = []
    const add = (value) => {
      const id = typeof value === 'string' ? value.trim() : ''
      if (id !== '' && !requested.includes(id)) requested.push(id)
    }
    add(input?.sessionId)
    if (Array.isArray(input?.sessionIds)) for (const value of input.sessionIds) add(value)

    // Every conversation the restart interrupts must come back, not only the
    // one that asked. This lives in the ENGINE rather than in the tool because
    // a restart can also be scheduled by a panel, an HTTP caller, or a script
    // that drives `scheduleRestart` directly — all of which used to wake only
    // their own conversation and silently strand the others mid-task.
    // `allConversations: false` is the explicit opt-out.
    if (input?.allConversations !== false) {
      let discovered = []
      try {
        discovered = await this.listResumable()
      } catch (error) {
        this.logger?.warn?.(`could not discover interrupted conversations: ${String(error)}`)
      }
      for (const candidate of discovered) add(candidate.sessionId)
    }

    if (requested.length === 0) {
      throw new HotRestartError('session-required', 'a restart must name at least one exact session to wake')
    }

    const requestId = input.requestId ?? `hot-restart-${randomBytes(8).toString('hex')}`
    // The caller's own prompt describes the CALLER's work ("verify these three
    // things"), so it must never be handed to a different conversation: doing
    // that told an unrelated agent to go verify somebody else's task. Only the
    // requesting session gets the operator's prompt; every other conversation
    // is resumed with instructions derived from its own last activity.
    const callerSessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim() !== '' ? input.sessionId.trim() : undefined
    const operatorPrompt = typeof input.prompt === 'string' && input.prompt.trim() !== '' ? input.prompt.trim() : undefined
    // Fail safe when the caller is ambiguous: if a prompt was supplied but no
    // single caller is named, and more than one conversation would be woken, we
    // cannot know whose wording it is — so nobody gets it. A conversation that
    // loses a custom prompt still resumes correctly; a conversation that
    // receives somebody else's prompt abandons its own work.
    const promptRecipient =
      operatorPrompt === undefined
        ? undefined
        : callerSessionId !== undefined
          ? callerSessionId
          : requested.length === 1
            ? requested[0]
            : undefined
    if (operatorPrompt !== undefined && promptRecipient === undefined) {
      this.logger?.warn?.(
        `refusing to deliver a custom prompt to ${requested.length} conversations: no single caller was named, so each gets its own derived continuation`,
      )
    }

    const pendingWakes = []
    const refused = []
    for (const sessionId of requested) {
      const observation = await this.observe(sessionId)
      if (observation === undefined) {
        refused.push({ sessionId, reason: 'session-not-found' })
        continue
      }
      const verdict = checkFingerprint({ sessionId }, observation, this.archivedSessionIds())
      if (!verdict.ok) {
        refused.push({ sessionId, reason: verdict.reason })
        continue
      }
      const pending = pendingFromObservation(observation, requestId, input.reason)
      const isCaller = promptRecipient !== undefined && sessionId === promptRecipient
      if (isCaller && operatorPrompt !== undefined) {
        pending.prompt = operatorPrompt
      } else {
        // Per-conversation continuation, built from what THAT conversation was
        // doing. `promptSource` records where it came from so the panel and the
        // ledger can explain why two conversations got different messages.
        const resume = buildResumePrompt(observation.events, sessionId)
        pending.prompt = resume.prompt
        pending.promptSource = resume.source
      }
      pending.previousBootId = this.bootId
      pendingWakes.push(pending)
    }

    // Fail closed on an empty set: a restart that wakes nobody is never what the
    // operator asked for, and it would still kill the process.
    if (pendingWakes.length === 0) {
      const first = refused[0]
      if (first === undefined) {
        throw new HotRestartError('session-required', 'a restart must name at least one exact session to wake')
      }
      // Keep the established single-session codes (`session-not-found`,
      // `session-archived`, ...) so callers and the panel keep their handling.
      const code = first.reason.startsWith('session-') ? first.reason : `session-${first.reason}`
      throw new HotRestartError(
        code,
        `refusing to schedule a wake for session "${first.sessionId}": ${first.reason}`,
      )
    }

    this.ledger.pendingWakes = pendingWakes
    this.ledger.pending = pendingWakes[0]
    this.ledger.restart = createRestartRequest(requestId, Date.now(), input.requestedBy ?? 'panel')
    this.ledger.restart.notBefore = Date.now() + this.config.graceMs
    this.ledger.restart.sessionIds = pendingWakes.map((pending) => pending.sessionId)
    this.wakeAttemptsBySession = new Map()
    // A restart whose intent never reached disk loses the wake, so a failed
    // write fails the request instead of letting the shell kill the process.
    try {
      this.save()
    } catch (error) {
      this.ledger.pendingWakes = []
      this.ledger.pending = null
      this.ledger.restart = null
      throw new HotRestartError('ledger-write-failed', `could not record the restart intent: ${String(error)}`)
    }
    this.logger?.info?.(
      `scheduled restart; will wake ${pendingWakes.length} session(s) as ${requestId}: ${pendingWakes
        .map((pending) => pending.sessionId)
        .join(', ')}`,
    )
    return { pending: pendingWakes[0], pendingWakes, refused, restart: this.ledger.restart }
  }

  /**
   * Abandon a scheduled restart and every wake it owes.
   * @param reason - why it was cancelled.
   * @returns whether anything was cancelled.
   */
  cancel(reason = 'cancelled') {
    const owed = Array.isArray(this.ledger.pendingWakes) ? this.ledger.pendingWakes : []
    const had = this.ledger.restart !== null || owed.length > 0
    for (const pending of owed) {
      pushHistory(this.ledger, { kind: 'wake-cancelled', wakeId: pending.wakeId, sessionId: pending.sessionId, reason })
    }
    if (owed.length === 0 && had) pushHistory(this.ledger, { kind: 'restart-cancelled', reason })
    this.ledger.restart = null
    this.ledger.pendingWakes = []
    this.ledger.pending = null
    this.save()
    return had
  }

  /**
   * Answer the renderer's poll: should the shell restart right now?
   *
   * Marking the attempt happens here, under the single-threaded event loop, so
   * two windows cannot both claim the same dispatch.
   *
   * @param now - current time.
   * @returns `{ restart: boolean, reason?: string, status }`.
   */
  dispatchVerdict(now = Date.now()) {
    const restart = this.ledger.restart
    if (restart === null) return { restart: false, reason: 'no-restart-request', status: this.status() }
    if (restartIsStale(restart, now, this.config.restartTtlMs)) {
      pushHistory(this.ledger, { kind: 'restart-expired', wakeId: restart.wakeId })
      this.ledger.restart = null
      this.save()
      return { restart: false, reason: 'restart-request-expired', status: this.status() }
    }
    if (Number.isFinite(restart.notBefore) && now < restart.notBefore) {
      return { restart: false, reason: 'restart-grace-period', status: this.status() }
    }
    const verdict = restartDispatchDue(restart, now, {
      ttlMs: this.config.restartTtlMs,
      maxAttempts: this.config.maxRestartAttempts,
      retryMs: this.config.restartRetryMs,
    })
    if (!verdict.due) return { restart: false, reason: verdict.reason, status: this.status() }
    const channel = this.channel.active()
    restart.attempts = Number(restart.attempts ?? 0) + 1
    restart.lastAttemptAt = now
    restart.dispatchedAt = now
    // On the launchd channel the Host performs the restart itself, so the
    // attempt is only recorded once the helper accepted the job. The renderer
    // channel is the opposite: recording here is what hands it the turn.
    let dispatched = { ok: true, detail: 'delegated to the renderer' }
    if (channel === 'launchd') dispatched = this.channel.dispatch()
    this.save()
    if (!dispatched.ok) {
      pushHistory(this.ledger, { kind: 'restart-dispatch-failed', wakeId: restart.wakeId, reason: dispatched.detail })
      this.save()
      return { restart: false, reason: 'restart-dispatch-failed', status: this.status() }
    }
    this.logger?.info?.(`dispatching harness restart via ${channel} (attempt ${restart.attempts}) for wake ${restart.wakeId}`)
    // `restart: true` means "the dispatch was issued", not "this caller must act
    // on it". The renderer only acts when `channel === 'renderer-ipc'`; on the
    // launchd channel the helper has already been started from here.
    return { restart: true, channel, status: this.status() }
  }

  /**
   * Note that the renderer's restart call rejected or never reached the shell.
   * @param reason - the observed failure.
   */
  noteDispatchFailure(reason) {
    if (this.ledger.restart !== null) {
      pushHistory(this.ledger, { kind: 'restart-dispatch-failed', wakeId: this.ledger.restart.wakeId, reason: String(reason) })
      this.save()
    }
    this.logger?.warn?.(`harness restart dispatch failed: ${String(reason)}`)
  }

  /**
   * Start (or retry) the wake for every conversation the ledger still owes.
   *
   * One restart can owe several wakes. Each is attempted independently: a
   * conversation that is missing, archived, or mid-attach must not stop the
   * others from being resumed, because that is exactly the "only one
   * conversation came back" failure this list exists to prevent.
   *
   * @returns the wake outcome (or the list, when several are owed), or
   *   undefined when nothing is owed.
   */
  async runWake() {
    if (this.disposed) return undefined
    if (this.wakeInFlight !== undefined) return this.wakeInFlight
    const owed = wakesOwedToAnotherBoot(this.ledger.pendingWakes, this.bootId)
    if (owed.length === 0) {
      // Either nothing is owed, or this boot scheduled the restart and has not
      // restarted yet. Delivering here would wake a conversation inside the same
      // process — a "wake" with no restart behind it. It belongs to the next boot.
      if (Array.isArray(this.ledger.pendingWakes) && this.ledger.pendingWakes.length > 0) {
        this.logger?.info?.('a wake is scheduled; waiting for the restart to hand it to the next boot')
      }
      return undefined
    }
    if (!this.config.autoWake) {
      this.logger?.info?.('autoWake is disabled; leaving the pending wakes for the operator')
      return undefined
    }
    this.wakeInFlight = (async () => {
      // Safety net: a restart scheduled by an older build (or by any caller
      // that recorded only its own conversation) still owes wakes to the
      // conversations it interrupted. Without this, those conversations stay
      // stranded mid-turn with no message telling them the Host came back.
      const owedIds = new Set(owed.map((pending) => pending.sessionId))
      try {
        for (const candidate of await this.listResumable()) {
          if (owedIds.has(candidate.sessionId)) continue
          const observation = await this.observe(candidate.sessionId)
          if (observation === undefined) continue
          const verdict = checkFingerprint({ sessionId: candidate.sessionId }, observation, this.archivedSessionIds())
          if (!verdict.ok) continue
          const adopted = pendingFromObservation(observation, owed[0].wakeId, owed[0].reason)
          // Never inherit another conversation's prompt: it describes work this
          // agent never did. Derive one from this conversation's own tail.
          const resume = buildResumePrompt(observation.events, candidate.sessionId)
          adopted.prompt = resume.prompt
          adopted.promptSource = resume.source
          adopted.previousBootId = owed[0].previousBootId
          owed.push(adopted)
          owedIds.add(candidate.sessionId)
          this.logger?.info?.(`wake adopted an interrupted conversation: ${candidate.sessionId} (${candidate.reason})`)
        }
      } catch (error) {
        this.logger?.warn?.(`could not adopt interrupted conversations: ${String(error)}`)
      }
      const outcomes = []
      for (const pending of owed) {
        if (this.disposed) break
        try {
          outcomes.push(await this.wake(pending))
        } catch (error) {
          // Containment per conversation: one broken target must not abort the
          // rest. It is recorded so the panel can explain what was left behind.
          const message = error instanceof Error ? error.message : String(error)
          this.logger?.warn?.(`wake for ${pending.sessionId} threw: ${message}`)
          outcomes.push(this.settleWake(pending, { ok: false, reason: 'wake-threw', message }, false))
        }
      }
      // Backwards-compatible return shape: a single owed conversation still
      // resolves to its own outcome record, while several resolve to the list.
      return outcomes.length === 1 ? outcomes[0] : outcomes
    })().finally(() => {
      this.wakeInFlight = undefined
    })
    return this.wakeInFlight
  }

  /**
   * Deliver one wake, or record precisely why it was refused.
   * @param pending - the ledger's pending wake.
   * @returns the outcome record.
   */
  async wake(pending) {
    const now = Date.now()
    const target = pending.sessionId
    const observation = await this.observe(target)
    if (observation === undefined) {
      return this.settleWake(
        pending,
        {
          ok: false,
          reason: 'session-not-found',
          message: `session "${target}" no longer exists; refusing to guess a replacement`,
        },
        false,
      )
    }
    const verdict = checkFingerprint(pending, observation, this.archivedSessionIds())
    if (!verdict.ok) {
      // Fingerprint failures are terminal: the conversation the operator meant
      // is not the one on disk, so there is nothing safe to wake.
      return this.settleWake(
        pending,
        { ok: false, reason: verdict.reason, detail: verdict.detail, message: `wake refused: ${verdict.reason}` },
        false,
      )
    }
    const already = findWakeDelivery(observation.events, pending.wakeId, pending.requestId)
    if (already !== undefined) {
      return this.settleWake(
        pending,
        { ok: true, reason: 'already-delivered', message: 'the wake was already in the session log', seq: already.seq },
        true,
      )
    }
    const text = buildWakeText({
      wakeId: pending.wakeId,
      sessionId: target,
      reason: pending.reason,
      prompt: pending.prompt,
      previousBoot: this.ledger.previousBootId ?? pending.previousBootId,
    })
    let agent
    try {
      agent = await this.attach(target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient = isTransientAttachFailure(error)
      const attempts = this.noteWakeAttempt(pending)
      if (transient && attempts < this.config.maxWakeAttempts) {
        this.logger?.warn?.(`wake attach failed (attempt ${attempts}), will retry: ${message}`)
        this.save()
        return { ok: false, reason: 'retry', message }
      }
      return this.settleWake(pending, { ok: false, reason: transient ? 'attach-retries-exhausted' : 'attach-failed', message }, false)
    }
    try {
      const delivered = await this.deliver(agent, text, pending.requestId ?? pending.wakeId)
      if (!delivered) throw new Error('the agent rejected the wake message')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const attempts = this.noteWakeAttempt(pending)
      if (attempts < this.config.maxWakeAttempts) {
        this.logger?.warn?.(`wake delivery failed (attempt ${attempts}), will retry: ${message}`)
        this.save()
        return { ok: false, reason: 'retry', message }
      }
      return this.settleWake(pending, { ok: false, reason: 'delivery-failed', message }, false)
    }
    this.logger?.info?.(`woke session ${target} with ${pending.wakeId}`)
    return this.settleWake(
      pending,
      {
        ok: true,
        reason: 'woken',
        message: `woke session ${target}`,
        marker: wakeMarker(pending.wakeId),
        elapsedMs: Date.now() - now,
      },
      true,
    )
  }

  /**
   * Count one attempt for one conversation.
   *
   * Per-session, not per-boot: with several owed wakes a shared counter would
   * let one flaky conversation exhaust another conversation's retries.
   *
   * @param pending - the wake being attempted.
   * @returns this wake's attempt count after incrementing.
   */
  noteWakeAttempt(pending) {
    const key = pending.sessionId
    if (!(this.wakeAttemptsBySession instanceof Map)) this.wakeAttemptsBySession = new Map()
    const attempts = (this.wakeAttemptsBySession.get(key) ?? 0) + 1
    this.wakeAttemptsBySession.set(key, attempts)
    return attempts
  }

  /**
   * Attempt count already spent on one conversation.
   * @param sessionId - the conversation id.
   * @returns the attempt count.
   */
  attemptsFor(sessionId) {
    if (!(this.wakeAttemptsBySession instanceof Map)) return 0
    return this.wakeAttemptsBySession.get(sessionId) ?? 0
  }

  /**
   * Record one wake outcome and drop that wake from the owed list.
   *
   * A restart owes wakes to several conversations, so settling one must never
   * cancel the others: only an empty list ends the restart. A wake that is
   * still retryable stays in the list.
   *
   * @param pending - the wake that was attempted.
   * @param outcome - what happened.
   * @param delivered - whether the message reached the session.
   * @returns the outcome.
   */
  settleWake(pending, outcome, delivered) {
    const record = {
      wakeId: pending.wakeId,
      sessionId: pending.sessionId,
      at: Date.now(),
      bootId: this.bootId,
      attempt: this.attemptsFor(pending.sessionId),
      ...outcome,
    }
    this.ledger.lastWake = record
    pushHistory(this.ledger, {
      kind: delivered ? 'wake-delivered' : 'wake-failed',
      wakeId: pending.wakeId,
      sessionId: pending.sessionId,
      reason: outcome.reason,
    })
    const retryable = !delivered && outcome.reason === 'retry'
    if (!retryable) {
      const remaining = (Array.isArray(this.ledger.pendingWakes) ? this.ledger.pendingWakes : []).filter(
        (candidate) => candidate.sessionId !== pending.sessionId,
      )
      this.ledger.pendingWakes = remaining
      this.ledger.pending = remaining[0] ?? null
      if (remaining.length === 0) this.ledger.restart = null
    }
    this.save()
    if (!delivered) {
      this.logger?.warn?.(`wake for ${pending.sessionId} failed: ${outcome.reason} ${outcome.message ?? ''}`.trim())
    }
    return record
  }

  /**
   * Attach to the target session, reusing a live agent when possible.
   * @param sessionId - exact session id.
   * @returns the agent.
   */
  async attach(sessionId) {
    const agents = this.requireAgents()
    const SessionId = this.sessionIdFactory()
    const id = SessionId(sessionId)
    const live = agents.get(id)
    if (live !== undefined) return live
    const attached = this.ctx.get?.('sessions')?.get?.(id)
    if (attached !== undefined) {
      const existing = agents.get(id)
      if (existing !== undefined) return existing
    }
    const options = { resumeSessionId: id }
    const defaults = this.defaultModel()
    if (defaults !== undefined) options.agentOptions = defaults
    const setup = await this.wakeSetup(sessionId)
    if (setup !== undefined) options.setup = setup
    const handle = await agents.resume(options)
    const agent = handle?.agent ?? handle
    if (agent === undefined) throw new HotRestartError('resume-returned-nothing', `resuming "${sessionId}" produced no agent`)
    return agent
  }

  /**
   * Build the composition callback for a resume.
   *
   * Best effort by design: a preset that cannot be mounted must never cost the
   * operator their wake, so every failure here degrades instead of throwing.
   *
   * @param sessionId - session being resumed.
   * @returns setup callback, or undefined when nothing can be composed.
   */
  async wakeSetup(sessionId) {
    const presets = this.ctx.get?.('agentPresets')
    if (presets === undefined || typeof presets.mount !== 'function') return undefined
    const presetId = await this.presetFor(sessionId)
    return async (agentCtx) => {
      let resolvedId
      try {
        resolvedId = (await presets.resolve(presetId)).id
      } catch {
        try {
          resolvedId = (await presets.resolve('standard')).id
        } catch {
          return
        }
      }
      try {
        await presets.mount(agentCtx, resolvedId)
      } catch (error) {
        this.logger?.warn?.(
          `could not mount agent preset "${resolvedId}" while waking ${sessionId}: ${String(error)}`,
        )
      }
    }
  }

  /**
   * The agent preset a session was last using.
   * @param sessionId - session id.
   * @returns preset id, or undefined for the registry default.
   */
  async presetFor(sessionId) {
    const projections = this.ctx.get?.('sessionProjections')
    const session = this.ctx.get?.('sessions')?.get?.(this.sessionIdFactory()(sessionId))
    if (projections !== undefined && typeof projections.stateOf === 'function' && session !== undefined) {
      try {
        const state = projections.stateOf(session, 'agentPreset')
        if (typeof state === 'string' && state !== '') return state
      } catch {}
    }
    const observation = await this.observe(sessionId)
    const projected = observation?.projections?.values?.agentPreset
    if (typeof projected === 'string' && projected !== '') return projected
    const headerPreset = observation?.header?.agentPreset
    if (typeof headerPreset === 'string' && headerPreset !== '') return headerPreset
    return undefined
  }

  /**
   * Deliver the wake text through the agent's own inbox.
   *
   * `source.rpcId` carries the wake id so the Host's own prompt admission
   * recognises a replay of the same wake, exactly like an RPC prompt would.
   *
   * @param agent - the resumed or live agent.
   * @param text - message body carrying the wake marker.
   * @param requestId - stable wake id used as the message's rpcId.
   * @returns whether the agent accepted it.
   */
  async deliver(agent, text, requestId) {
    const { createUserMessage } = await this.llmMessage()
    const source = requestId === undefined ? { kind: 'user' } : { kind: 'user', rpcId: requestId }
    const message = createUserMessage({ content: [{ type: 'text', text }], source })
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return true
    }
    if (typeof agent.steer === 'function') {
      agent.steer(message)
      return true
    }
    return false
  }

  /**
   * Observe a session without activating an agent.
   * @param sessionId - exact session id.
   * @returns `{ header, events, projections }`, or undefined when absent.
   */
  async observe(sessionId) {
    const SessionId = this.sessionIdFactory()
    const id = SessionId(sessionId)
    const live = this.ctx.get?.('sessions')?.get?.(id)
    if (live !== undefined) {
      return {
        header: live.header,
        events: snapshotEvents(live),
        projections: undefined,
      }
    }
    const sessionQuery = this.ctx.get?.('sessionQuery')
    if (sessionQuery !== undefined && typeof sessionQuery.observeSession === 'function') {
      try {
        const observation = await sessionQuery.observeSession(id)
        if (observation !== undefined && observation !== null) {
          return {
            header: observation.header ?? observation.meta,
            events: Array.isArray(observation.events) ? observation.events : [],
            projections: normalizeProjections(observation.projections),
          }
        }
      } catch (error) {
        if (!isQueryNotFound(error)) throw error
        return undefined
      }
    }
    const persistence = this.ctx.get?.('sessionPersistence')
    if (persistence !== undefined) {
      if (typeof persistence.inspect === 'function') {
        try {
          const inspected = await persistence.inspect(id)
          if (inspected !== undefined && inspected !== null) {
            return {
              header: inspected.meta ?? inspected.header,
              events: Array.isArray(inspected.events) ? inspected.events : [],
              projections: normalizeProjections(inspected.projections),
            }
          }
        } catch {}
      }
      if (typeof persistence.list === 'function') {
        const headers = await persistence.list()
        const header = Array.isArray(headers) ? headers.find((candidate) => candidate?.id === sessionId) : undefined
        if (header !== undefined) return { header, events: [], projections: undefined }
      }
    }
    return undefined
  }

  /**
   * The Host's agent registry, or a clear error.
   * @returns the agent registry.
   */
  requireAgents() {
    const agents = this.ctx.get?.('agents')
    if (agents === undefined) {
      throw new HotRestartError('agents-unavailable', 'the agents registry is not available in this Host')
    }
    return agents
  }

  /**
   * Default model selection to hand a resumed agent.
   * @returns `{ provider, model }`, or undefined.
   */
  defaultModel() {
    const defaults = this.ctx.get?.('agentDefaultModel')
    if (defaults === undefined || typeof defaults.currentSelection !== 'function') return undefined
    try {
      const selection = defaults.currentSelection()
      if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        return undefined
      }
      return { provider: selection.provider, model: selection.model }
    } catch {
      return undefined
    }
  }

  /**
   * Session id factory.
   *
   * `SessionId` is a branded string; the brand exists only at the type level and
   * has no runtime behaviour. This deliberately does NOT `import()` the
   * `@deepseek-ai/dsh-session` package: that lives inside the Desktop's
   * `app.asar` and is unresolvable from a profile plugin, and the brand adds
   * nothing the runtime would check.
   *
   * @returns a session id factory.
   */
  sessionIdFactory() {
    if (this.sessionId === undefined) this.sessionId = (value) => value
    return this.sessionId
  }

  /**
   * Build the user-message factory used to deliver a wake.
   *
   * `createUserMessage` from `@deepseek-ai/dsh-llm/message` is a
   * `structuredClone` plus a fresh `randomUUID`, so it is reproduced here
   * instead of imported: that package is `app.asar`-internal and cannot be
   * resolved from a profile plugin.
   *
   * A caller may still inject its own factory (tests do), and that always wins.
   *
   * @returns the message factory module.
   */
  async llmMessage() {
    if (this.injectedCreateUserMessage !== undefined) {
      return { createUserMessage: this.injectedCreateUserMessage }
    }
    if (this.llmModule === undefined) {
      this.llmModule = {
        // Mirrors the kernel's `createMessage`: clone, stamp a fresh UUID, then
        // deep-freeze. The freeze is part of the contract — the Host publishes
        // these messages as immutable history, and an unfrozen one could be
        // mutated after it was appended.
        createUserMessage: (input) => deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' })),
      }
    }
    return this.llmModule
  }

  /**
   * Begin the periodic "is anything owed?" loop.
   * @param intervalMs - poll interval.
   */
  start(intervalMs = 2_000) {
    this.stop()
    const tick = async () => {
      if (this.disposed) return
      try {
        if (this.ledger.pending !== null) await this.runWake()
      } catch (error) {
        this.logger?.warn?.(`wake loop error: ${String(error)}`)
      }
      if (this.disposed) return
      this.timer = setTimeout(tick, intervalMs)
      this.timer?.unref?.()
    }
    this.timer = setTimeout(tick, Math.max(250, intervalMs))
    this.timer?.unref?.()
  }

  /**
   * Stop the loop.
   */
  stop() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Release everything.
   */
  dispose() {
    this.disposed = true
    this.stop()
  }
}

function snapshotEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  } catch {}
  const events = session.events
  return Array.isArray(events) ? events : []
}

function normalizeProjections(projections) {
  if (projections === undefined || projections === null) return undefined
  const values = projections.values ?? projections
  if (values === undefined || values === null || typeof values !== 'object') return undefined
  return { values }
}

function isQueryNotFound(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return true
  return typeof error.name === 'string' && error.name === 'SessionQuerySessionNotFound'
}

/**
 * Whether an attach failure is worth retrying.
 *
 * Matched on the message because these come from several different layers
 * (persistence, the agent registry, the session writer) that do not share an
 * error type. A stable code is honoured first when one is present.
 *
 * @param error - the thrown value.
 * @returns true when a later attempt could plausibly succeed.
 */
function isTransientAttachFailure(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (['SESSION_ALREADY_OWNED', 'WRITER_HELD', 'AGENT_REGISTERED', 'NO_AGENT_FACTORY'].includes(code)) return true
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('no agent factory registered') ||
    message.includes('persistence is not configured') ||
    message.includes('SessionAlreadyOwnedError') ||
    message.includes('writer-held') ||
    message.includes('is already registered')
  )
}

/**
 * Normalize the plugin configuration into runtime limits.
 * @param raw - user configuration.
 * @returns normalized configuration.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  return {
    autoWake: config.autoWake !== false,
    wakeIdle: config.wakeIdle !== false,
    graceMs: positive(config.graceMs, 1_500),
    restartTtlMs: positive(config.restartTtlMs, 60_000),
    restartRetryMs: positive(config.restartRetryMs, 20_000),
    maxRestartAttempts: positive(config.maxRestartAttempts, 3),
    maxWakeAttempts: positive(config.maxWakeAttempts, 5),
    wakePollMs: positive(config.wakePollMs, 2_000),
  }
}

function positive(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * Freeze an object and every plain object/array it contains.
 *
 * The kernel's message factory freezes what it publishes; reproducing that here
 * keeps a wake message indistinguishable from one the Host built itself.
 *
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}
