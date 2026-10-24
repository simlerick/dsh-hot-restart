/**
 * Engine-level behaviour: the ledger across boots, dispatch verdicts, and the
 * wake that must never fire inside the process that scheduled it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HotRestart, HotRestartError, LEDGER_FILE, resolveConfig } from '../lib/core.js'

const SESSION_ID = 'session-52b5b649-426f-4674-8bde-50c9829a4f00'

function sessionHeader(overrides = {}) {
  return {
    id: SESSION_ID,
    cwd: '/work',
    createdAt: 1_760_000_000_000,
    agentPreset: 'standard',
    ...overrides,
  }
}

/**
 * A Host stand-in exposing exactly the services the engine touches.
 */
function fakeCtx({ header = sessionHeader(), events = [], archived = [], listRecords = [], failResume = false } = {}) {
  const agents = {
    get: () => undefined,
    resume: async () => {
      if (failResume) throw new Error('no agent factory registered')
      return { agent: { followup: () => {}, steer: () => {} } }
    },
  }
  return {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
      if (name === 'sessionQuery') {
        return {
          observeSession: async () => ({ header, events, projections: undefined }),
          listSessions: async () => listRecords,
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
}

/**
 * A restart channel that records instead of acting.
 *
 * This is not a convenience: the real launchd channel writes a plist into
 * `~/Library/LaunchAgents` and kills the app, so a test that let it run would
 * restart the machine's editor every time the suite executed. Tests may only
 * ever observe the dispatch, never perform one.
 */
function fakeChannel(options = {}) {
  const calls = []
  const channel = options.channel ?? 'launchd'
  return {
    calls,
    active: () => channel,
    noteRendererBridge: (present) => {
      calls.push({ kind: 'noteRendererBridge', present })
    },
    describe: () => ({ channel, platform: 'test', rendererBridge: undefined, script: null, app: null, helper: null, hint: '' }),
    dispatch: () => {
      calls.push({ kind: 'dispatch' })
      return { ok: true, channel, detail: 'recorded by the test double' }
    },
  }
}

function makeEngine(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  const channel = options.channel ?? fakeChannel(options)
  const engine = new HotRestart({
    ctx: options.ctx ?? fakeCtx(options),
    dataDir: dir,
    config: resolveConfig({ graceMs: 1 }),
    logger: { info: () => {}, warn: () => {} },
    createUserMessage: options.createUserMessage ?? ((input) => input),
    channel,
  })
  return { engine, dir, channel, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a fresh engine writes a ledger with nothing owed', () => {
  const { engine, dir, cleanup } = makeEngine()
  try {
    engine.load()
    const onDisk = JSON.parse(readFileSync(join(dir, LEDGER_FILE), 'utf8'))
    assert.equal(onDisk.pending, null)
    assert.equal(onDisk.restart, null)
    assert.equal(onDisk.bootId, engine.bootId)
  } finally {
    cleanup()
  }
})

test('scheduling records the fingerprint taken while the session is live', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionId: SESSION_ID, reason: 'upgrade' })
    assert.equal(scheduled.pending.sessionId, SESSION_ID)
    assert.equal(scheduled.pending.cwd, '/work')
    assert.equal(scheduled.pending.createdAt, 1_760_000_000_000)
    assert.equal(scheduled.pending.reason, 'upgrade')
    assert.equal(engine.status().pending.sessionId, SESSION_ID)
  } finally {
    cleanup()
  }
})

test('scheduling an unknown session is refused', async () => {
  const ctx = fakeCtx()
  const original = ctx.get
  ctx.get = (name) => (name === 'sessionQuery' ? { observeSession: async () => undefined } : original.call(ctx, name))
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    await assert.rejects(
      () => engine.scheduleRestart({ sessionId: SESSION_ID }),
      (error) => error instanceof HotRestartError && error.code === 'session-not-found',
    )
  } finally {
    cleanup()
  }
})

test('scheduling without a session id is refused', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.load()
    await assert.rejects(
      () => engine.scheduleRestart({ sessionId: '  ' }),
      (error) => error instanceof HotRestartError && error.code === 'session-required',
    )
  } finally {
    cleanup()
  }
})

test('a subagent session cannot be scheduled', async () => {
  const { engine, cleanup } = makeEngine({ ctx: fakeCtx({ header: sessionHeader({ origin: 'subagent' }) }) })
  try {
    engine.load()
    await assert.rejects(
      () => engine.scheduleRestart({ sessionId: SESSION_ID }),
      (error) => error instanceof HotRestartError && error.code === 'session-subagent-session',
    )
  } finally {
    cleanup()
  }
})

test('the scheduling boot does not deliver its own wake', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.load()
    await engine.scheduleRestart({ sessionId: SESSION_ID })
    // Still the same boot: the restart has not happened, so nothing is owed.
    const outcome = await engine.runWake()
    assert.equal(outcome, undefined)
    assert.notEqual(engine.status().pending, null)
  } finally {
    cleanup()
  }
})

test('the next boot delivers the wake and clears the record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    await first.scheduleRestart({ sessionId: SESSION_ID })
    first.dispose()

    const delivered = []
    const second = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    // Capture what the agent receives through its own followup.
    const originalGet = second.ctx.get
    second.ctx.get = (name) => {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async () => ({ agent: { followup: (message) => delivered.push(message) } }),
        }
      }
      return originalGet.call(second.ctx, name)
    }
    second.load()
    const outcome = await second.runWake()
    assert.equal(outcome.ok, true)
    assert.equal(outcome.reason, 'woken')
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /\[\[dsh-hot-restart wake=/)
    assert.equal(delivered[0].source.rpcId, outcome.wakeId)
    assert.equal(second.status().pending, null)
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wake already present in the log is not delivered twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    const scheduled = await first.scheduleRestart({ sessionId: SESSION_ID })
    first.dispose()

    // Simulate a crash after delivery but before the ledger recorded it.
    const marker = `[[dsh-hot-restart wake=${scheduled.pending.wakeId}]]`
    const second = new HotRestart({
      ctx: fakeCtx({
        events: [{ type: 'user/message', seq: 12, data: { source: { rpcId: scheduled.pending.wakeId }, content: [{ type: 'text', text: marker }] } }],
      }),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    let followups = 0
    const originalGet = second.ctx.get
    second.ctx.get = (name) => {
      if (name === 'agents') {
        return { get: () => undefined, resume: async () => ({ agent: { followup: () => { followups += 1 } } }) }
      }
      return originalGet.call(second.ctx, name)
    }
    second.load()
    const outcome = await second.runWake()
    assert.equal(outcome.reason, 'already-delivered')
    assert.equal(followups, 0, 'a replay must not deliver a second message')
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wake whose session vanished is refused, not guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    await first.scheduleRestart({ sessionId: SESSION_ID })
    first.dispose()

    const missing = {
      get(name) {
        if (name === 'agents') return { get: () => undefined, resume: async () => ({ agent: {} }) }
        if (name === 'sessions') return { get: () => undefined }
        if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
        if (name === 'sessionQuery') return { observeSession: async () => undefined }
        return undefined
      },
    }
    const second = new HotRestart({
      ctx: missing,
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    second.load()
    const outcome = await second.runWake()
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, 'session-not-found')
    assert.equal(second.status().pending, null)
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch waits out the grace period, then fires once', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.load()
    const now = Date.now()
    await engine.scheduleRestart({ sessionId: SESSION_ID })
    const during = engine.dispatchVerdict(now)
    assert.equal(during.restart, false)
    assert.equal(during.reason, 'restart-grace-period')

    const after = engine.dispatchVerdict(Date.now() + 10_000)
    assert.equal(after.restart, true)
    assert.equal(after.status.restart.attempts, 1)

    const again = engine.dispatchVerdict(Date.now() + 10_001)
    assert.equal(again.restart, false)
    assert.equal(again.reason, 'restart-retry-backoff')
  } finally {
    cleanup()
  }
})

test('the boot that performed the dispatch does not re-dispatch', () => {
  const { engine, dir, cleanup } = makeEngine()
  try {
    engine.load()
    engine.ledger.restart = {
      wakeId: 'w1',
      requestedAt: Date.now(),
      requestedBy: 'panel',
      attempts: 1,
      lastAttemptAt: Date.now(),
    }
    engine.save()
    // A new process reading that ledger must see the restart as completed.
    const next = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({}),
      logger: { info: () => {}, warn: () => {} },
    })
    next.load()
    assert.equal(next.ledger.restart, null)
    assert.ok(next.ledger.history.some((entry) => entry.kind === 'restart-completed'))
    next.dispose()
  } finally {
    cleanup()
  }
})

test('cancel clears both the restart and the pending wake', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.load()
    await engine.scheduleRestart({ sessionId: SESSION_ID })
    assert.equal(engine.cancel('changed my mind'), true)
    assert.equal(engine.status().pending, null)
    assert.equal(engine.status().restart, null)
    assert.equal(engine.cancel('again'), false)
  } finally {
    cleanup()
  }
})

test('autoWake off leaves the wake pending for the operator', async () => {
  const ctx = fakeCtx()
  const engine = new HotRestart({
    ctx,
    dataDir: mkdtempSync(join(tmpdir(), 'hr-core-')),
    config: resolveConfig({ autoWake: false }),
    logger: { info: () => {}, warn: () => {} },
    createUserMessage: (input) => input,
  })
  try {
    engine.load()
    await engine.scheduleRestart({ sessionId: SESSION_ID })
    engine.bootId = 'different-boot'
    assert.equal(await engine.runWake(), undefined)
    assert.notEqual(engine.status().pending, null)
  } finally {
    engine.dispose()
  }
})

test('listTargets excludes subagents and archived sessions', async () => {
  const ctx = fakeCtx({
    listRecords: [
      { id: 'session-aaaaaaaa-1111', cwd: '/a', createdAt: 3, title: 'live' },
      { id: 'session-bbbbbbbb-2222', cwd: '/b', createdAt: 2, origin: 'subagent' },
      { id: 'session-cccccccc-3333', cwd: '/c', createdAt: 1 },
    ],
    archived: ['session-cccccccc-3333'],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const rows = await engine.listTargets()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-aaaaaaaa-1111')
    assert.equal(rows[0].title, 'live')
  } finally {
    cleanup()
  }
})

test('listTargets is newest-first and bounded', async () => {
  const records = []
  for (let index = 0; index < 10; index += 1) {
    records.push({ id: `session-${String(index).padStart(8, '0')}-x`, createdAt: index })
  }
  const ctx = fakeCtx({ listRecords: records })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const rows = await engine.listTargets(3)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].createdAt, 9)
  } finally {
    cleanup()
  }
})

test('a Host without sessionQuery simply lists nothing', async () => {
  const { engine, cleanup } = makeEngine({
    ctx: { get: (name) => (name === 'agents' ? { get: () => undefined } : undefined) },
  })
  try {
    engine.load()
    assert.deepEqual(await engine.listTargets(), [])
  } finally {
    cleanup()
  }
})

test('a lost ledger write fails the schedule instead of losing the wake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const engine = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    engine.load()
    engine.save = () => {
      throw new Error('disk full')
    }
    await assert.rejects(
      () => engine.scheduleRestart({ sessionId: SESSION_ID }),
      (error) => error instanceof HotRestartError && error.code === 'ledger-write-failed',
    )
    assert.equal(engine.ledger.pending, null, 'a failed write must not leave a phantom wake')
    assert.equal(engine.ledger.restart, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveConfig falls back on nonsense values', () => {
  const config = resolveConfig({ graceMs: -5, maxWakeAttempts: 'seven', wakePollMs: NaN })
  assert.equal(config.graceMs, 1_500)
  assert.equal(config.maxWakeAttempts, 5)
  assert.equal(config.wakePollMs, 2_000)
  assert.equal(config.autoWake, true)
  assert.equal(resolveConfig({ autoWake: false }).autoWake, false)
})

// ── multi-conversation wakes ────────────────────────────────────────────────
//
// One restart must resume every conversation it interrupted. These are the
// tests that keep "only one conversation came back" from regressing.

const SECOND_ID = 'session-7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f'

/**
 * A Host whose sessionQuery knows several conversations.
 * @param ids - session ids to expose.
 * @param events - per-session event logs.
 * @returns a fake context.
 */
function fakeMultiCtx(ids, events = {}) {
  const ctx = fakeCtx()
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        observeSession: async (id) => {
          const key = typeof id === 'string' ? id : String(id)
          if (!ids.includes(key)) return undefined
          return { header: sessionHeader({ id: key }), events: events[key] ?? [], projections: undefined }
        },
        listSessions: async () => ids.map((id) => ({ id, cwd: '/work', createdAt: 1_760_000_000_000 })),
      }
    }
    return original.call(ctx, name)
  }
  return ctx
}

test('one restart records a wake for every named conversation', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID])
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionIds: [SESSION_ID, SECOND_ID], reason: 'plugin update' })
    assert.equal(scheduled.pendingWakes.length, 2)
    assert.deepEqual(
      scheduled.pendingWakes.map((pending) => pending.sessionId),
      [SESSION_ID, SECOND_ID],
    )
    assert.equal(scheduled.restart.sessionIds.length, 2)
    const status = engine.status()
    assert.equal(status.pendingWakes.length, 2)
    // The legacy alias still names the first owed conversation.
    assert.equal(status.pending.sessionId, SESSION_ID)
  } finally {
    cleanup()
  }
})

test('the next boot wakes every owed conversation, not just the first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    await first.scheduleRestart({ sessionIds: [SESSION_ID, SECOND_ID] })
    first.dispose()

    const delivered = []
    const second = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    const originalGet = second.ctx.get
    second.ctx.get = (name) => {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (options) => ({
            agent: {
              id: options.resumeSessionId,
              followup: (message) => delivered.push({ sessionId: options.resumeSessionId, message }),
            },
          }),
        }
      }
      return originalGet.call(second.ctx, name)
    }
    second.load()
    const outcomes = await second.runWake()
    assert.equal(Array.isArray(outcomes), true)
    assert.equal(outcomes.length, 2)
    assert.equal(outcomes.every((outcome) => outcome.ok === true), true)
    assert.deepEqual(
      delivered.map((entry) => entry.sessionId),
      [SESSION_ID, SECOND_ID],
    )
    assert.equal(second.status().pendingWakes.length, 0)
    assert.equal(second.status().pending, null)
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a conversation that vanished does not block the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    await first.scheduleRestart({ sessionIds: [SESSION_ID, SECOND_ID] })
    first.dispose()

    const delivered = []
    // Only the first conversation still exists on the next boot.
    const second = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    const originalGet = second.ctx.get
    second.ctx.get = (name) => {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (options) => ({
            agent: { id: options.resumeSessionId, followup: (message) => delivered.push(message) },
          }),
        }
      }
      return originalGet.call(second.ctx, name)
    }
    second.load()
    const outcomes = await second.runWake()
    assert.equal(outcomes.length, 2)
    assert.equal(outcomes[0].ok, true)
    assert.equal(outcomes[1].ok, false)
    assert.equal(outcomes[1].reason, 'session-not-found')
    // The healthy conversation still got its wake, and nothing is left owed.
    assert.equal(delivered.length, 1)
    assert.equal(second.status().pendingWakes.length, 0)
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown conversation alongside a known one is reported, not fatal', async () => {
  const ctx = fakeMultiCtx([SESSION_ID])
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionIds: [SESSION_ID, 'session-missing'] })
    assert.equal(scheduled.pendingWakes.length, 1)
    assert.equal(scheduled.refused.length, 1)
    assert.equal(scheduled.refused[0].sessionId, 'session-missing')
    assert.equal(scheduled.refused[0].reason, 'session-not-found')
  } finally {
    cleanup()
  }
})

test('a legacy single-pending ledger is promoted to the wake list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    // Write the shape an older build produced: one `pending`, no list.
    const legacy = {
      schema: 2,
      bootId: 'old-boot',
      bootedAt: 1_760_000_000_000,
      previousBootId: 'older-boot',
      restart: { wakeId: 'w1', requestedAt: Date.now() - 1_000, attempts: 0 },
      pending: {
        wakeId: 'w1',
        requestId: 'w1',
        sessionId: SESSION_ID,
        cwd: '/work',
        createdAt: 1_760_000_000_000,
        previousBootId: 'old-boot',
      },
      lastWake: null,
      history: [],
    }
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(legacy))
    const engine = new HotRestart({
      ctx: fakeCtx(),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    engine.load()
    assert.equal(engine.ledger.pendingWakes.length, 1)
    assert.equal(engine.ledger.pendingWakes[0].sessionId, SESSION_ID)
    engine.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attempts are counted per conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const first = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    first.load()
    await first.scheduleRestart({ sessionIds: [SESSION_ID, SECOND_ID] })
    first.dispose()

    const second = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID]),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    // Both attaches fail transiently, so both stay owed with their own count.
    const originalGet = second.ctx.get
    second.ctx.get = (name) => {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async () => {
            throw new Error('no agent factory registered')
          },
        }
      }
      return originalGet.call(second.ctx, name)
    }
    second.load()
    await second.runWake()
    assert.equal(second.attemptsFor(SESSION_ID), 1)
    assert.equal(second.attemptsFor(SECOND_ID), 1)
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listTargets reads the header wrapper that sessionQuery actually returns', async () => {
  // sessionQuery.listSessions() resolves `{ header, live, persisted }`. Reading
  // identity off the wrapper (rather than `header`) silently emptied the list.
  const ctx = fakeCtx()
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        listSessions: async () => [
          { header: { id: SESSION_ID, cwd: '/work', createdAt: 1_760_000_000_000, agentPreset: 'cordis' }, live: true, persisted: true },
          { header: { id: SECOND_ID, cwd: '/work', createdAt: 1_760_000_000_500 }, live: false, persisted: true },
          { header: { id: 'session-sub', origin: 'subagent' }, live: false, persisted: true },
        ],
        observeSession: async () => undefined,
      }
    }
    return original.call(ctx, name)
  }
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const rows = await engine.listTargets()
    assert.deepEqual(
      rows.map((row) => row.sessionId),
      [SECOND_ID, SESSION_ID],
    )
    assert.equal(rows.find((row) => row.sessionId === SESSION_ID).live, true)
    assert.equal(rows.find((row) => row.sessionId === SESSION_ID).agentPreset, 'cordis')
  } finally {
    cleanup()
  }
})

// ── the engine, not the caller, decides what a restart wakes ────────────────
//
// A restart used to wake only the conversation named by whoever scheduled it.
// The panel, the tool and any script calling scheduleRestart directly all had
// to remember to enumerate the others, and a script that forgot stranded them.

test('scheduleRestart adopts every interrupted conversation by default', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    // SECOND_ID's log stops inside an open turn: the restart cut it off.
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: {} }],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    // Only one conversation is named, exactly like a hand-written script.
    const scheduled = await engine.scheduleRestart({ sessionId: SESSION_ID })
    assert.deepEqual(
      scheduled.pendingWakes.map((pending) => pending.sessionId).sort(),
      [SESSION_ID, SECOND_ID].sort(),
    )
  } finally {
    cleanup()
  }
})

test('allConversations false restricts the wake to the named set', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionId: SESSION_ID, allConversations: false })
    assert.deepEqual(
      scheduled.pendingWakes.map((pending) => pending.sessionId),
      [SESSION_ID],
    )
  } finally {
    cleanup()
  }
})

test('a finished conversation is not adopted', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionId: SESSION_ID })
    assert.deepEqual(
      scheduled.pendingWakes.map((pending) => pending.sessionId),
      [SESSION_ID],
    )
  } finally {
    cleanup()
  }
})

test('the wake adopts interrupted conversations the ledger never recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    // A ledger written by an older build: it only owes SESSION_ID, even though
    // SECOND_ID was also cut off mid-turn by that same restart.
    const legacy = {
      schema: 2,
      bootId: 'old-boot',
      bootedAt: 1_760_000_000_000,
      restart: { wakeId: 'w1', requestedAt: Date.now() - 1_000, attempts: 0 },
      pending: { wakeId: 'w1', requestId: 'w1', sessionId: SESSION_ID, previousBootId: 'old-boot' },
      history: [],
    }
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(legacy))

    const delivered = []
    const engine = new HotRestart({
      ctx: fakeMultiCtx([SESSION_ID, SECOND_ID], {
        [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }],
      }),
      dataDir: dir,
      config: resolveConfig({ graceMs: 1 }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    const originalGet = engine.ctx.get
    engine.ctx.get = (name) => {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (options) => ({
            agent: { id: options.resumeSessionId, followup: (message) => delivered.push(options.resumeSessionId) },
          }),
        }
      }
      return originalGet.call(engine.ctx, name)
    }
    engine.load()
    await engine.runWake()
    // Both conversations come back, even though the ledger named only one.
    assert.deepEqual(delivered.sort(), [SESSION_ID, SECOND_ID].sort())
    engine.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a prompt with no named caller is delivered to nobody', async () => {
  // The regression that shipped: the tool put every session in `sessionIds`
  // and omitted `sessionId`, so the engine could not tell who the prompt
  // belonged to and handed it to all of them.
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({
      sessionIds: [SESSION_ID, SECOND_ID],
      prompt: 'VERIFY-MY-THINGS',
    })
    for (const pending of scheduled.pendingWakes) {
      assert.doesNotMatch(pending.prompt, /VERIFY-MY-THINGS/)
      assert.equal(pending.promptSource !== undefined, true)
    }
  } finally {
    cleanup()
  }
})

test('a single named session still receives its prompt', async () => {
  const ctx = fakeMultiCtx([SESSION_ID])
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    // One target and no explicit caller: unambiguous, so it keeps the prompt.
    const scheduled = await engine.scheduleRestart({ sessionIds: [SESSION_ID], prompt: 'ONLY-ME' })
    assert.equal(scheduled.pendingWakes[0].prompt, 'ONLY-ME')
  } finally {
    cleanup()
  }
})

test('the caller is identified by sessionId even when listed again', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({
      sessionId: SESSION_ID,
      sessionIds: [SESSION_ID, SECOND_ID],
      prompt: 'CALLER-ONLY',
    })
    const byId = new Map(scheduled.pendingWakes.map((pending) => [pending.sessionId, pending]))
    assert.equal(byId.get(SESSION_ID).prompt, 'CALLER-ONLY')
    assert.doesNotMatch(byId.get(SECOND_ID).prompt, /CALLER-ONLY/)
  } finally {
    cleanup()
  }
})

test('an open conversation that finished its turn is still woken', async () => {
  const ctx = fakeMultiCtx([SESSION_ID], {})
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        observeSession: async () => ({ header: sessionHeader(), events: [], projections: undefined }),
        // `live: true` with no running agent means the turn had finished.
        listSessions: async () => [{ header: sessionHeader(), live: true }],
      }
    }
    return original.call(ctx, name)
  }
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const scheduled = await engine.scheduleRestart({ sessionId: SESSION_ID, allConversations: true })
    assert.equal(scheduled.pendingWakes.length, 1)
    assert.equal(scheduled.pendingWakes[0].sessionId, SESSION_ID)
  } finally {
    cleanup()
  }
})

test('wakeIdle: false keeps the mid-task-only behaviour', async () => {
  const ctx = fakeMultiCtx([SESSION_ID], {})
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        observeSession: async () => ({ header: sessionHeader(), events: [], projections: undefined }),
        listSessions: async () => [{ header: sessionHeader(), live: true }],
      }
    }
    return original.call(ctx, name)
  }
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const engine = new HotRestart({
      ctx,
      dataDir: dir,
      config: resolveConfig({ graceMs: 1, wakeIdle: false }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    engine.load()
    const rows = await engine.listResumable()
    assert.equal(rows.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── idle conversations are NOT woken by default ─────────────────────────────
//
// A finished conversation has no work to resume. Waking it makes an agent speak
// again with nothing to do, which the operator reads as "why did this fire,
// there was no work here". Default must be mid-task only.

test('an idle-but-open conversation is not woken by default', async () => {
  const ctx = fakeMultiCtx([SESSION_ID, SECOND_ID], {
    // SECOND_ID finished its turn cleanly: nothing to resume.
    [SECOND_ID]: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }],
  })
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        observeSession: async (id) => {
          const key = String(id)
          if (![SESSION_ID, SECOND_ID].includes(key)) return undefined
          return {
            header: sessionHeader({ id: key }),
            events: key === SECOND_ID
              ? [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }]
              : [],
            projections: undefined,
          }
        },
        // Both conversations are OPEN (live), but only SESSION_ID is working.
        listSessions: async () => [
          { header: sessionHeader({ id: SESSION_ID }), live: true },
          { header: sessionHeader({ id: SECOND_ID }), live: true },
        ],
      }
    }
    return original.call(ctx, name)
  }
  const { engine, cleanup } = makeEngine({ ctx })
  try {
    engine.load()
    const resumable = await engine.listResumable()
    assert.deepEqual(
      resumable.map((row) => row.sessionId),
      [],
      'a finished conversation must not be listed as needing continuation',
    )
  } finally {
    cleanup()
  }
})

test('wakeIdle: true opts back in to waking open-but-finished conversations', async () => {
  const ctx = fakeMultiCtx([SECOND_ID])
  const original = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        observeSession: async (id) => ({
          header: sessionHeader({ id: String(id) }),
          events: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }],
          projections: undefined,
        }),
        listSessions: async () => [{ header: sessionHeader({ id: SECOND_ID }), live: true }],
      }
    }
    return original.call(ctx, name)
  }
  const dir = mkdtempSync(join(tmpdir(), 'hr-core-'))
  try {
    const engine = new HotRestart({
      ctx,
      dataDir: dir,
      config: resolveConfig({ graceMs: 1, wakeIdle: true }),
      logger: { info: () => {}, warn: () => {} },
      createUserMessage: (input) => input,
    })
    engine.load()
    const rows = await engine.listResumable()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].reason, 'open-idle')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
