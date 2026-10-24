/**
 * The RPC surface the settings panel talks to.
 *
 * The rule under test is that a business failure is a *value*, never a throw:
 * the panel has to be able to explain itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VIEW_CHANNEL, VIEW_ENDPOINTS, createViewHandler, registerViewChannel } from '../lib/view.js'
import { HotRestartError } from '../lib/core.js'

const SESSION_ID = 'session-52b5b649-426f-4674-8bde-50c9829a4f00'

function fakeEngine(overrides = {}) {
  return {
    status: () => ({ bootId: 'boot-1', pending: null, history: [] }),
    listTargets: async () => [{ sessionId: SESSION_ID }],
    scheduleRestart: async (input) => {
      const ids = Array.isArray(input.sessionIds) && input.sessionIds.length > 0 ? input.sessionIds : [input.sessionId]
      return {
        pending: { sessionId: ids[0], wakeId: 'w1' },
        pendingWakes: ids.map((sessionId) => ({ sessionId, wakeId: 'w1' })),
        refused: [],
        restart: { wakeId: 'w1' },
      }
    },
    listResumable: async () => [{ sessionId: SESSION_ID, reason: 'agent-running' }],
    cancel: () => true,
    dispatchVerdict: () => ({ restart: false, reason: 'no-restart-request', status: {} }),
    noteDispatchFailure: () => {},
    ...overrides,
  }
}

test('the channel path is stable', () => {
  assert.equal(VIEW_CHANNEL, '/dsh-hot-restart-view')
  assert.deepEqual(VIEW_ENDPOINTS, [
    'state',
    'targets',
    'resumable',
    'schedule',
    'cancel',
    'poll',
    'note-failure',
    'note-channel',
  ])
})

test('state answers with the engine snapshot', async () => {
  const handler = createViewHandler(fakeEngine())
  const result = await handler('state', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.bootId, 'boot-1')
})

test('targets returns the listable conversations', async () => {
  const handler = createViewHandler(fakeEngine())
  const result = await handler('targets', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.targets[0].sessionId, SESSION_ID)
})

test('targets passes a bounded limit through', async () => {
  let seen
  const handler = createViewHandler(
    fakeEngine({
      listTargets: async (limit) => {
        seen = limit
        return []
      },
    }),
  )
  await handler('targets', { limit: 5 })
  assert.equal(seen, 5)
  await handler('targets', { limit: -3 })
  assert.equal(seen, 40, 'an invalid limit falls back to the default')
})

test('schedule forwards the operator intent', async () => {
  let received
  const handler = createViewHandler(
    fakeEngine({
      scheduleRestart: async (input) => {
        received = input
        return { pending: { sessionId: input.sessionId, wakeId: 'w1' }, restart: {} }
      },
    }),
  )
  const result = await handler('schedule', { sessionId: SESSION_ID, reason: 'upgrade', prompt: 'go on' })
  assert.equal(result.ok, true)
  assert.equal(received.sessionId, SESSION_ID)
  assert.equal(received.reason, 'upgrade')
  assert.equal(received.prompt, 'go on')
  assert.equal(received.requestedBy, 'settings')
})

test('schedule defaults its attribution to the settings surface', async () => {
  let received
  const handler = createViewHandler(
    fakeEngine({
      scheduleRestart: async (input) => {
        received = input
        return { pending: { sessionId: input.sessionId, wakeId: 'w1' }, restart: {} }
      },
    }),
  )
  await handler('schedule', { sessionId: SESSION_ID, requestedBy: 'panel' })
  assert.equal(received.requestedBy, 'panel', 'an explicit attribution is preserved')
})

test('a business failure becomes a bad-request result with its reason', async () => {
  const handler = createViewHandler(
    fakeEngine({
      scheduleRestart: async () => {
        throw new HotRestartError('session-not-found', 'no such session')
      },
    }),
  )
  const result = await handler('schedule', { sessionId: SESSION_ID })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.equal(result.error.message, 'no such session')
  assert.equal(result.error.details.reason, 'session-not-found')
})

test('an unexpected failure becomes an internal result', async () => {
  const handler = createViewHandler(
    fakeEngine({
      status: () => {
        throw new Error('boom')
      },
    }),
  )
  const result = await handler('state', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
})

test('an unknown endpoint is a bad request, not a crash', async () => {
  const handler = createViewHandler(fakeEngine())
  const result = await handler('nope', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
})

test('malformed payloads are tolerated', async () => {
  const handler = createViewHandler(fakeEngine())
  for (const payload of [null, undefined, 'string', 42, [1, 2]]) {
    const result = await handler('state', payload)
    assert.equal(result.ok, true, `payload ${JSON.stringify(payload)} must not throw`)
  }
})

test('poll exposes the dispatch verdict', async () => {
  const handler = createViewHandler(fakeEngine({ dispatchVerdict: () => ({ restart: true, status: {} }) }))
  const result = await handler('poll', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.restart, true)
})

test('note-failure is forwarded to the engine', async () => {
  let seen
  const handler = createViewHandler(
    fakeEngine({
      noteDispatchFailure: (reason) => {
        seen = reason
      },
    }),
  )
  await handler('note-failure', { reason: 'invoke rejected' })
  assert.equal(seen, 'invoke rejected')
})

test('registering without a usable connection fails loudly', () => {
  assert.throws(() => registerViewChannel(undefined, fakeEngine()), /no connection\.rpc/u)
  assert.throws(() => registerViewChannel({ rpc: {} }, fakeEngine()), /no connection\.rpc/u)
})

test('registering returns a safe disposer', () => {
  let disposed = false
  const connection = {
    rpc: {
      handle: () => () => {
        disposed = true
      },
    },
  }
  const dispose = registerViewChannel(connection, fakeEngine())
  dispose()
  assert.equal(disposed, true)
  dispose() // idempotent
})

test('a disposer that returns a promise does not leak a rejection', async () => {
  const connection = { rpc: { handle: () => () => Promise.reject(new Error('teardown')) } }
  const dispose = registerViewChannel(connection, fakeEngine())
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(true, 'an unhandled rejection would have failed the process')
})
