/**
 * Host-side RPC surface for the settings panel.
 *
 * Two rules this module enforces:
 *
 * - Business failures never throw. They are folded into `RpcResult` errors so
 *   the panel can explain itself instead of showing "500 internal".
 * - `RpcErrorCode` is a closed union, so plugin-specific reasons travel in
 *   `details.reason` and the code stays `bad-request` / `internal`.
 *
 * @module dsh-hot-restart/view
 */

import { HotRestartError } from './core.js'

/** The RPC channel this plugin answers on. */
export const VIEW_CHANNEL = '/dsh-hot-restart-view'

/** Endpoints the panel may call. */
export const VIEW_ENDPOINTS = [
  'state',
  'targets',
  'resumable',
  'schedule',
  'cancel',
  'poll',
  'note-failure',
  'note-channel',
]

/**
 * Build the RPC handler bound to an engine.
 * @param engine - the hot-restart engine.
 * @param options - optional logger and clock.
 * @returns an endpoint dispatcher.
 */
export function createViewHandler(engine, options = {}) {
  const logger = options.logger
  const now = options.now ?? (() => Date.now())

  /**
   * @param endpoint - requested endpoint.
   * @param payload - raw client payload.
   * @returns an RpcResult.
   */
  return async function handleViewRequest(endpoint, payload) {
    const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    try {
      if (endpoint === 'state') return success(engine.status())
      if (endpoint === 'targets') {
        const limit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : 40
        return success({ targets: await engine.listTargets(limit) })
      }
      if (endpoint === 'resumable') {
        // Conversations a restart would interrupt mid-task. The panel offers
        // these so "restart and continue everything" is one click, not a hunt
        // through the sidebar for each conversation that was busy.
        const limit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : 20
        return success({ resumable: await engine.listResumable(limit) })
      }
      if (endpoint === 'schedule') {
        const sessionIds = Array.isArray(body.sessionIds)
          ? body.sessionIds.filter((value) => typeof value === 'string' && value.trim() !== '')
          : []
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const scheduled = await engine.scheduleRestart({
          sessionId: sessionIds.length === 0 ? sessionId : undefined,
          sessionIds,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
          requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'settings',
        })
        return success({
          pending: scheduled.pending,
          pendingWakes: scheduled.pendingWakes,
          refused: scheduled.refused,
          restart: scheduled.restart,
          status: engine.status(),
        })
      }
      if (endpoint === 'cancel') {
        const cancelled = engine.cancel(typeof body.reason === 'string' ? body.reason : 'cancelled by operator')
        return success({ cancelled, status: engine.status() })
      }
      if (endpoint === 'poll') {
        return success(engine.dispatchVerdict(now()))
      }
      if (endpoint === 'note-channel') {
        // The renderer is the only place that can see `window.dshDesktop`, so it
        // reports whether the official bridge exists. Without this the Host would
        // have to guess, and guessing wrong is what makes a macOS install look
        // broken when it is merely using the launchd channel instead.
        engine.channel.noteRendererBridge(body.bridge === true)
        return success({ status: engine.status() })
      }
      if (endpoint === 'note-failure') {
        engine.noteDispatchFailure(typeof body.reason === 'string' ? body.reason : 'unknown')
        return success({ status: engine.status() })
      }
      return badRequest(`unknown panel endpoint ${JSON.stringify(endpoint)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`panel request failed (${endpoint}): ${message}`)
      if (error instanceof HotRestartError) return badRequest(message, error.code)
      return failure('internal', message)
    }
  }
}

/**
 * Register the panel channel on the Host connection.
 * @param connection - the Host connection handle.
 * @param engine - the hot-restart engine.
 * @param options - optional logger.
 * @returns a disposer.
 */
export function registerViewChannel(connection, engine, options = {}) {
  const rpc = connection?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') {
    throw new HotRestartError(
      'connection-unavailable',
      'this Host has no connection.rpc, so the settings panel cannot connect',
    )
  }
  const handler = createViewHandler(engine, options)
  const dispose = rpc.handle(VIEW_CHANNEL, handler)
  return () => {
    try {
      const pending = typeof dispose === 'function' ? dispose() : undefined
      if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
    } catch {}
  }
}

function success(value) {
  return { ok: true, value }
}

function badRequest(message, reason) {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message,
      details: reason === undefined ? { issues: [] } : { issues: [], reason },
    },
  }
}

function failure(code, message, reason) {
  return { ok: false, error: { code, message, details: reason === undefined ? {} : { reason } } }
}
