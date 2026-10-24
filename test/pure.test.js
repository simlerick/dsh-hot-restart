/**
 * Guards that decide whether a wake may target a session, and whether a wake
 * already landed.
 *
 * These are the tests that protect "do not wake the wrong conversation", so
 * they cover the negative cases in far more detail than the happy path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildResumePrompt,
  buildWakeText,
  checkFingerprint,
  createLedger,
  createRestartRequest,
  findWakeDelivery,
  fingerprintOf,
  isSessionIdLike,
  isWakeText,
  lastActivity,
  lastUserRequest,
  normalizeLedger,
  normalizePendingWakes,
  pendingFromObservation,
  pushHistory,
  restartDispatchDue,
  restartIsStale,
  sessionEndsMidTurn,
  wakeMarker,
  wakeOwedToAnotherBoot,
  wakesOwedToAnotherBoot,
} from '../lib/pure.js'

const SESSION = {
  header: {
    id: 'session-52b5b649-426f-4674-8bde-50c9829a4f00',
    cwd: 'D:\\work',
    createdAt: 1_760_000_000_000,
    agentPreset: 'standard',
  },
}

test('fingerprint keeps only durable identity fields', () => {
  const fingerprint = fingerprintOf(SESSION)
  assert.equal(fingerprint.sessionId, SESSION.header.id)
  assert.equal(fingerprint.cwd, SESSION.header.cwd)
  assert.equal(fingerprint.createdAt, SESSION.header.createdAt)
  assert.equal(fingerprint.origin, undefined)
  assert.equal(fingerprint.parentSession, undefined)
})

test('a matching session is allowed', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const verdict = checkFingerprint(pending, SESSION, [])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.fingerprint.sessionId, SESSION.header.id)
})

test('a different session id is refused', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const other = { header: { ...SESSION.header, id: 'session-other' } }
  const verdict = checkFingerprint(pending, other, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'session-id-mismatch')
  assert.equal(verdict.detail.expected, SESSION.header.id)
  assert.equal(verdict.detail.observed, 'session-other')
})

test('a subagent session is never a wake target', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const subagent = { header: { ...SESSION.header, origin: 'subagent' } }
  const verdict = checkFingerprint(pending, subagent, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'subagent-session')
})

test('an archived session is refused', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const verdict = checkFingerprint(pending, SESSION, [SESSION.header.id])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'session-archived')
})

test('a changed working directory is refused', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const moved = { header: { ...SESSION.header, cwd: 'D:\\elsewhere' } }
  const verdict = checkFingerprint(pending, moved, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cwd-mismatch')
})

test('a re-created session id is refused because createdAt differs', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const recreated = { header: { ...SESSION.header, createdAt: SESSION.header.createdAt + 1 } }
  const verdict = checkFingerprint(pending, recreated, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'created-at-mismatch')
})

test('an observation without a session id is refused', () => {
  const pending = pendingFromObservation(SESSION, 'wake-1')
  const verdict = checkFingerprint(pending, { header: {} }, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'observation-has-no-session')
})

test('a pending wake without a session is refused', () => {
  const verdict = checkFingerprint({ wakeId: 'x' }, SESSION, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'pending-wake-has-no-session')
})

test('a non-object pending wake is refused', () => {
  const verdict = checkFingerprint(null, SESSION, [])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no-pending-wake')
})

test('a wake marker is embedded and detectable', () => {
  const marker = wakeMarker('wake-7')
  assert.equal(marker, '[[dsh-hot-restart wake=wake-7]]')
  assert.ok(buildWakeText({ wakeId: 'wake-7', sessionId: 's1' }).includes(marker))
})

test('an operator prompt is added but never replaces the restart framing', () => {
  const text = buildWakeText({ wakeId: 'w', sessionId: 's1', prompt: 'check the deploy' })
  assert.ok(text.includes('check the deploy'))
  // The framing must survive a custom prompt. Dropping it made a wake look like
  // an ordinary new message, so the agent started over instead of continuing.
  assert.ok(text.includes('热重启完成'))
  assert.ok(text.includes('本对话是重启前那次工作的延续'))
})

test('a wake with no prompt still states that the process restarted', () => {
  const text = buildWakeText({ wakeId: 'w', sessionId: 's1' })
  assert.ok(text.includes('热重启完成'))
  assert.ok(text.includes('继续未完成的任务'))
})

test('delivery is found by rpcId even when the marker is absent', () => {
  const events = [{ type: 'user/message', data: { source: { rpcId: 'wake-9' }, content: [{ type: 'text', text: 'hi' }] } }]
  assert.ok(findWakeDelivery(events, 'wake-9', 'wake-9') !== undefined)
})

test('delivery is found by marker even when rpcId differs', () => {
  const marker = wakeMarker('wake-9')
  const events = [{ type: 'user/message', data: { source: { rpcId: 'other' }, content: [{ type: 'text', text: marker }] } }]
  assert.ok(findWakeDelivery(events, 'wake-9', 'wake-9') !== undefined)
})

test('an unrelated user message is not a delivery', () => {
  const events = [{ type: 'user/message', data: { source: { rpcId: 'other' }, content: [{ type: 'text', text: 'hi' }] } }]
  assert.equal(findWakeDelivery(events, 'wake-9', 'wake-9'), undefined)
})

test('non-array event logs are tolerated', () => {
  assert.equal(findWakeDelivery(undefined, 'w', 'w'), undefined)
  assert.equal(findWakeDelivery(null, 'w', 'w'), undefined)
})

test('a wake scheduled by this boot is not delivered by it', () => {
  const pending = { previousBootId: 'boot-a' }
  assert.equal(wakeOwedToAnotherBoot(pending, 'boot-a'), false)
  assert.equal(wakeOwedToAnotherBoot(pending, 'boot-b'), true)
})

test('a legacy pending wake without a boot id is delivered', () => {
  assert.equal(wakeOwedToAnotherBoot({ sessionId: 's' }, 'boot-a'), true)
  assert.equal(wakeOwedToAnotherBoot(null, 'boot-a'), false)
})

test('normalizeLedger keeps pending work and rewrites the boot identity', () => {
  const raw = {
    schema: 2,
    bootId: 'old-boot',
    bootedAt: 1_760_000_000_000,
    pending: { sessionId: 's1', wakeId: 'w1' },
    lastWake: { ok: true },
    history: [{ kind: 'x' }],
  }
  const ledger = normalizeLedger(raw, 'new-boot', 1_700_000_000_000)
  assert.equal(ledger.bootId, 'new-boot')
  assert.equal(ledger.bootedAt, 1_700_000_000_000)
  assert.equal(ledger.previousBootId, 'old-boot')
  assert.equal(ledger.pending.sessionId, 's1')
  assert.equal(ledger.lastWake.ok, true)
  assert.equal(ledger.history.length, 1)
})

test('normalizeLedger survives junk on disk', () => {
  for (const junk of [null, undefined, 'nope', 42, [1, 2, 3]]) {
    const ledger = normalizeLedger(junk, 'boot')
    assert.equal(ledger.bootId, 'boot')
    assert.equal(ledger.pending, null)
    assert.equal(ledger.restart, null)
  }
})

test('a fresh ledger has nothing owed', () => {
  const ledger = createLedger('boot')
  assert.equal(ledger.pending, null)
  assert.equal(ledger.restart, null)
  assert.equal(ledger.previousBootId, null)
  assert.deepEqual(ledger.history, [])
})

test('dispatch is due for a fresh request', () => {
  const restart = createRestartRequest('wake-1', 1_000)
  assert.equal(restartDispatchDue(restart, 1_000).due, true)
})

test('dispatch backs off after a failed attempt', () => {
  const restart = createRestartRequest('wake-1', 1_000)
  restart.attempts = 1
  restart.lastAttemptAt = 1_000
  assert.deepEqual(restartDispatchDue(restart, 1_000, { retryMs: 20_000 }), {
    due: false,
    reason: 'restart-retry-backoff',
  })
  assert.equal(restartDispatchDue(restart, 21_000, { retryMs: 20_000 }).due, true)
})

test('dispatch stops at the attempt cap', () => {
  const restart = createRestartRequest('wake-1', 1_000)
  restart.attempts = 3
  restart.lastAttemptAt = 0
  // Inside the freshness window, so the attempt cap is what stops it — not expiry.
  assert.deepEqual(restartDispatchDue(restart, 2_000, { ttlMs: 60_000, maxAttempts: 3, retryMs: 1 }), {
    due: false,
    reason: 'restart-attempts-exhausted',
  })
})

test('an expired request is not dispatched', () => {
  const restart = createRestartRequest('wake-1', 1_000)
  assert.deepEqual(restartDispatchDue(restart, 100_000, { ttlMs: 60_000 }), {
    due: false,
    reason: 'restart-request-expired',
  })
})

test('a malformed restart record is never dispatched', () => {
  assert.equal(restartDispatchDue(undefined, 1).due, false)
  assert.equal(restartDispatchDue({}, 1).reason, 'restart-request-has-no-timestamp')
})

test('staleness tracks the ttl', () => {
  const restart = createRestartRequest('wake-1', 1_000)
  assert.equal(restartIsStale(restart, 2_000, 60_000), false)
  assert.equal(restartIsStale(restart, 100_000, 60_000), true)
  assert.equal(restartIsStale(null), true)
})

test('history is bounded and newest-first', () => {
  const ledger = createLedger('boot')
  for (let index = 0; index < 30; index += 1) pushHistory(ledger, { kind: `k${index}` })
  assert.equal(ledger.history.length, 20)
  assert.equal(ledger.history[0].kind, 'k29')
})

test('session id shape check rejects noise', () => {
  assert.equal(isSessionIdLike('session-52b5b649-426f-4674-8bde-50c9829a4f00'), true)
  assert.equal(isSessionIdLike('short'), false)
  assert.equal(isSessionIdLike(''), false)
  assert.equal(isSessionIdLike(null), false)
})

// ── multi-conversation ledger ───────────────────────────────────────────────

test('a fresh ledger owes nothing and carries an empty wake list', () => {
  const ledger = createLedger('boot-1')
  assert.deepEqual(ledger.pendingWakes, [])
  assert.equal(ledger.pending, null)
})

test('normalizePendingWakes promotes a legacy single pending record', () => {
  const legacy = {
    bootId: 'old',
    pending: { wakeId: 'w1', sessionId: SESSION.header.id },
  }
  const wakes = normalizePendingWakes(legacy)
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].sessionId, SESSION.header.id)
})

test('normalizePendingWakes keeps the list and de-duplicates by session', () => {
  const raw = {
    pendingWakes: [
      { wakeId: 'w1', sessionId: 'a' },
      { wakeId: 'w2', sessionId: 'b' },
      { wakeId: 'w3', sessionId: 'a' },
    ],
  }
  const wakes = normalizePendingWakes(raw)
  assert.deepEqual(wakes.map((wake) => wake.sessionId), ['a', 'b'])
})

test('normalizePendingWakes drops entries without a session id', () => {
  const wakes = normalizePendingWakes({ pendingWakes: [{ wakeId: 'w1' }, { sessionId: 'a' }] })
  assert.deepEqual(wakes.map((wake) => wake.sessionId), ['a'])
})

test('normalizeLedger mirrors the first wake onto the legacy alias', () => {
  const ledger = normalizeLedger(
    { bootId: 'old', pendingWakes: [{ wakeId: 'w1', sessionId: 'a' }, { wakeId: 'w2', sessionId: 'b' }] },
    'boot-2',
  )
  assert.equal(ledger.pendingWakes.length, 2)
  assert.equal(ledger.pending.sessionId, 'a')
})

test('wakesOwedToAnotherBoot returns only the wakes of a previous boot', () => {
  const wakes = [
    { sessionId: 'a', previousBootId: 'old-boot' },
    { sessionId: 'b', previousBootId: 'this-boot' },
  ]
  const owed = wakesOwedToAnotherBoot(wakes, 'this-boot')
  assert.deepEqual(owed.map((wake) => wake.sessionId), ['a'])
})

test('wakesOwedToAnotherBoot tolerates a missing list', () => {
  assert.deepEqual(wakesOwedToAnotherBoot(undefined, 'b'), [])
  assert.deepEqual(wakesOwedToAnotherBoot(null, 'b'), [])
})

test('sessionEndsMidTurn detects a turn cut off by the restart', () => {
  assert.equal(
    sessionEndsMidTurn([
      { type: 'turn/start' },
      { type: 'assistant/message' },
    ]),
    true,
  )
})

test('sessionEndsMidTurn is false for a closed turn', () => {
  assert.equal(
    sessionEndsMidTurn([
      { type: 'turn/start' },
      { type: 'turn/end' },
    ]),
    false,
  )
})

test('sessionEndsMidTurn tracks the last turn, not the first', () => {
  assert.equal(
    sessionEndsMidTurn([
      { type: 'turn/start' },
      { type: 'turn/end' },
      { type: 'turn/start' },
    ]),
    true,
  )
})

test('sessionEndsMidTurn is false for an empty or malformed log', () => {
  assert.equal(sessionEndsMidTurn([]), false)
  assert.equal(sessionEndsMidTurn(undefined), false)
})

// ── per-conversation resume messages ────────────────────────────────────────
//
// The caller's prompt describes the CALLER's task. Handing it to another
// conversation told that agent to abandon its own work and go verify somebody
// else's, which is exactly what happened once.

function userEvent(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source } }
}

test('lastUserRequest ignores plugin-injected context', () => {
  const events = [
    userEvent('build the wallet plugin'),
    userEvent('<hanako-memory-snapshot>…</hanako-memory-snapshot>', { kind: 'hanako-memory' }),
    userEvent('runtime context', { kind: 'runtime-context' }),
  ]
  assert.equal(lastUserRequest(events), 'build the wallet plugin')
})

test('lastUserRequest picks the newest genuine request', () => {
  const events = [userEvent('first'), userEvent('second'), userEvent('third')]
  assert.equal(lastUserRequest(events), 'third')
})

test('lastUserRequest returns undefined when there is no user message', () => {
  assert.equal(lastUserRequest([]), undefined)
  assert.equal(lastUserRequest(undefined), undefined)
  assert.equal(lastUserRequest([{ type: 'turn/start', data: {} }]), undefined)
})

test('lastActivity names the tool the agent was calling', () => {
  const events = [
    { type: 'step/start', data: { step: 3 } },
    { type: 'tool/call', data: { name: 'ask_user_question' } },
  ]
  assert.equal(lastActivity(events), '正在调用 ask_user_question')
})

test('two conversations get different resume prompts', () => {
  const wallet = [userEvent('做一个 web3 钱包插件'), { type: 'tool/call', data: { name: 'web_search' } }]
  const restart = [userEvent('修改热重启的提示词'), { type: 'tool/call', data: { name: 'bash' } }]

  const a = buildResumePrompt(wallet, 'session-a')
  const b = buildResumePrompt(restart, 'session-b')

  assert.notEqual(a.prompt, b.prompt)
  assert.match(a.prompt, /web3 钱包插件/)
  assert.doesNotMatch(a.prompt, /修改热重启/)
  assert.match(b.prompt, /修改热重启/)
  assert.doesNotMatch(b.prompt, /web3 钱包/)
})

test('a resume prompt states the task and the interruption point', () => {
  const result = buildResumePrompt(
    [userEvent('修复历史加载'), { type: 'tool/call', data: { name: 'bash' } }],
    'session-x',
  )
  assert.equal(result.source, 'derived-last-request')
  assert.match(result.prompt, /不是一条新消息/)
  assert.match(result.prompt, /修复历史加载/)
  assert.match(result.prompt, /正在调用 bash/)
  assert.match(result.prompt, /不要重新开始/)
  // The session id belongs to the wake frame, not the continuation body:
  // buildWakeText appends it, so repeating it here printed it twice.
  assert.doesNotMatch(result.prompt, /session-x/)
})

test('a conversation with no user message still gets a usable prompt', () => {
  const result = buildResumePrompt([{ type: 'tool/call', data: { name: 'bash' } }], 'session-y')
  assert.equal(result.source, 'derived-activity')
  assert.match(result.prompt, /正在调用 bash/)
})

test('a long request is clipped', () => {
  const result = buildResumePrompt([userEvent('x'.repeat(2000))], 'session-z')
  assert.ok(result.prompt.length < 1200)
})

test('a message that merely QUOTES the marker is still a real request', () => {
  // Regression: the wake filter must not swallow a person's message just
  // because it mentions the marker (e.g. quoting a previous wake while
  // discussing it).
  const quoted = '你看这條：[[dsh-hot-restart wake=hot-restart-abc123]] 它嵌套了三层'
  assert.equal(isWakeText(quoted), false)
  assert.equal(lastUserRequest([userEvent(quoted)]), quoted)
})

test('a message that OPENS with the marker is a wake and is skipped', () => {
  const wake = '[[dsh-hot-restart wake=hot-restart-abc123]]\n\n【热重启完成】…'
  assert.equal(isWakeText(wake), true)
  assert.equal(lastUserRequest([userEvent('真正的工作'), userEvent(wake)]), '真正的工作')
})

test('leading whitespace before the marker still counts as a wake', () => {
  assert.equal(isWakeText('\n\n  [[dsh-hot-restart wake=hot-restart-x]] 后续'), true)
})
