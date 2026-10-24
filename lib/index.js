/**
 * dsh-hot-restart — restart the DSH Harness process and wake the conversation
 * that asked for it.
 *
 * The plugin is deliberately split in three:
 *
 * - this Host half owns the durable ledger and performs the wake;
 * - `lib/client.js` runs inside the Desktop renderer and is the only code that
 *   can reach the official restart entry
 *   (`window.dshDesktop.restartHarness()`), because the shell validates
 *   `event.sender === mainWindow.webContents`;
 * - `lib/core.js` + `lib/pure.js` hold every guard, with no Host dependencies,
 *   so the "do not wake the wrong session" rules are unit-testable.
 *
 * @module dsh-hot-restart
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HotRestart, resolveConfig } from './core.js'
import { ensureDir } from './fsutil.js'
import { createViewHandler } from './view.js'

/** Plugin name, also the loader id in `cordis.patch.yml`. */
export const name = 'dsh-hot-restart'

/** Same-origin HTTP path the panel posts to. */
export const VIEW_PATH = '/api/dsh-hot-restart'

/**
 * The one thing an agent must understand about restarting this Host.
 *
 * Written as a standing instruction rather than a tool description on purpose:
 * a tool description is only read when the model is deciding whether to call
 * that tool, whereas this rule has to hold for every turn that follows a
 * restart — including the first turn after one, when the model has no memory of
 * having asked for it. That is why the wake message carries an explicit marker:
 * it is the only signal that distinguishes "the process restarted" from "this
 * is a brand-new conversation".
 */
const SYSTEM_PROMPT_TEXT = [
  '## Restarting this Host — one mandatory path',
  '',
  '**Every restart of this Host MUST go through the `hot_restart` tool.** There is no second',
  'sanctioned path. Do not call the plugin\'s internal API from a shell (`scheduleRestart`,',
  '`RestartChannel.dispatch`, `import("./lib/core.js")`), do not run `launchctl`, `pkill`,',
  '`osascript ... quit`, and do not tell the user to quit and reopen the app. Those bypass the',
  'durable ledger, so the process dies with no record of what to resume — every conversation it',
  'interrupted is stranded mid-turn with nothing telling it the Host came back.',
  '',
  'Restarting DSH here is ALWAYS a hot restart: the process is replaced, and the conversation you',
  'were serving is resumed in the new process with your context intact. It is never a fresh start,',
  'and it never abandons the conversation.',
  '',
  'How it works, so you can rely on it:',
  '',
  '1. Call the `hot_restart` tool.',
  '2. The restart request and every target session are written to a durable ledger BEFORE the',
  '   process dies.',
  '3. The new process reads that ledger, resumes each recorded session, and delivers a message',
  '   beginning with `[[dsh-hot-restart wake=...]]`.',
  '',
  '**One restart resumes every interrupted conversation, not only yours.** The engine itself adds',
  'every conversation it finds mid-task (its agent still running, or its log ending inside an open',
  'turn), so you do not need to enumerate them and must not assume only your own comes back. Pass',
  '`allConversations: false` only when the operator explicitly wants a single conversation woken.',
  '',
  '**Each conversation gets its own wake message.** The `prompt` you pass describes YOUR task and is',
  'delivered only to your own conversation; every other conversation is resumed with a continuation',
  'derived from its own last request and last tool call. Never try to write one prompt for several',
  'conversations — you cannot see what they were doing, and the engine already handles it.',
  '',
  'When you see a message carrying that `[[dsh-hot-restart wake=...]]` marker, the restart already',
  'happened and this conversation is the continuation of the interrupted work. Treat the previous',
  'turn as your own unfinished work and carry on: do not re-introduce yourself, do not ask what the',
  'user wants, and do not treat the restart as an error or a lost state. Read the wake message for',
  'what to do next and continue from there.',
  '',
  'Before calling `hot_restart`, finish the turn with a short summary of what is done and what',
  'remains — the process dies mid-turn, so anything not yet written to the conversation is lost.',
  '',
  'Use it only when a reload is genuinely required (installing or updating a plugin, changing Host',
  'configuration). Never use it to wait, to retry a failed call, or to clear a transient error.',
].join('\n')

/**
 * Answer one panel request as JSON.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 * @returns a Response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * No hard service dependencies.
 *
 * This is deliberate and load-bearing: a plugin that declares a hard `inject`
 * will hold its own activation (and drag the Host's startup audit) when that
 * service is not available. Every service this plugin touches — `agents`,
 * `sessions`, `sessionQuery`, `agentPresets`, `agentDefaultModel`, `tools`,
 * `connection` — is read through `ctx.get()` with an `undefined` check, so a
 * Host that lacks any of them still boots and this plugin simply offers less.
 *
 * A restart helper is not worth costing the app its startup.
 */
export const inject = []

/**
 * Plugin configuration as a Standard-Schema implementation.
 *
 * Deliberately not `@deepseek-ai/schemastery`: that package lives inside the
 * Desktop's own `app.asar` and is NOT resolvable from a profile's
 * `node_modules`, so importing it makes the whole Host half fail to load with
 * `ERR_MODULE_NOT_FOUND` — which is exactly how an earlier build of this plugin
 * took every other plugin down with it.
 *
 * The shape is not free-form either. Cordis normalises a plugin's `Config` with
 *
 *     runtime.Config['~standard'].validate(raw)
 *
 * so a plain JSON-Schema *object* is NOT interchangeable: it has no `~standard`
 * and cordis throws `TypeError` on the way in, which fails activation and takes
 * startup down with it. Implementing the (tiny) Standard Schema surface keeps
 * the zero-dependency property without that trap.
 */

/** Field specs: type, default, and whether a value is accepted. */
const CONFIG_FIELDS = {
  dataDir: { type: 'string', default: undefined },
  autoWake: { type: 'boolean', default: true },
  wakeIdle: { type: 'boolean', default: true },
  graceMs: { type: 'number', default: 1500 },
  restartTtlMs: { type: 'number', default: 60000 },
  restartRetryMs: { type: 'number', default: 20000 },
  maxRestartAttempts: { type: 'number', default: 3 },
  maxWakeAttempts: { type: 'number', default: 5 },
  wakePollMs: { type: 'number', default: 2000 },
  ui: { type: 'boolean', default: true },
  tools: { type: 'boolean', default: true },
  systemPrompt: { type: 'boolean', default: true },
}

/**
 * Validate and fill in a raw plugin config.
 *
 * Unknown keys are dropped rather than rejected: a config written for a newer
 * build must never stop this one from starting.
 *
 * @param raw - whatever the loader handed us.
 * @returns `{ value }` on success, `{ issues }` on a type mismatch.
 */
function validateConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const value = {}
  const issues = []
  for (const [key, spec] of Object.entries(CONFIG_FIELDS)) {
    const candidate = input[key]
    if (candidate === undefined) {
      if (spec.default !== undefined) value[key] = spec.default
      continue
    }
    if (typeof candidate !== spec.type || (spec.type === 'number' && !Number.isFinite(candidate))) {
      issues.push({ message: `"${key}" must be a ${spec.type}`, path: [key] })
      continue
    }
    value[key] = candidate
  }
  if (issues.length > 0) return { issues }
  return { value }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-hot-restart',
    validate: validateConfig,
  },
  /** Descriptions for the settings renderer; not consulted by validation. */
  description: {
    dataDir: 'Directory that holds the restart ledger. Defaults to `<DSH_HOME>/dsh-hot-restart`.',
    autoWake: 'Wake the recorded session automatically after the Host comes back.',
    wakeIdle: 'Also wake conversations that are open but had already finished their turn, so every open conversation keeps working after a restart.',
    graceMs: 'Delay between scheduling and allowing the shell to restart.',
    restartTtlMs: 'How long a scheduled restart stays actionable.',
    restartRetryMs: 'Backoff before retrying a dispatch that did not take effect.',
    maxRestartAttempts: 'Maximum restart dispatches for one request.',
    maxWakeAttempts: 'Maximum wake attempts before giving up.',
    wakePollMs: 'How often to check whether a wake is still owed.',
    ui: 'Expose the hot-restart section in Settings.',
    tools: 'Expose the `hot_restart` tool to agents.',
    systemPrompt: 'Tell agents that a restart will resume their own conversation.',
  },
}

/**
 * Resolve the harness home directory.
 *
 * Local on purpose: `@deepseek-ai/dsh-home-paths` is an `app.asar`-internal
 * package and cannot be imported from a profile plugin.
 *
 * @returns the absolute `DSH_HOME` path.
 */
function resolveDshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured.replace(/[\\/]+$/u, '') : join(homedir(), '.dsh')
}

/**
 * Resolve the directory that holds the ledger.
 * @param config - plugin configuration.
 * @returns an absolute directory path.
 */
export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured !== '') return configured.replace(/[\\/]+$/u, '')
  try {
    return join(resolveDshHome(), 'dsh-hot-restart')
  } catch {
    return join(homedir(), '.dsh', 'dsh-hot-restart')
  }
}

/**
 * Bash patterns that mean "restart the Host by hand".
 *
 * The ledger is the only thing that survives the process, so a restart that
 * bypasses it strands every interrupted conversation. These patterns are
 * refused at the tool boundary: the operator keeps a single, auditable path
 * (`hot_restart`) instead of one that silently drops wakes.
 *
 * Deliberately narrow: reading the ledger, running the plugin's tests, or
 * importing `lib/pure.js` stays allowed, because those cannot restart anything.
 */
const BYPASS_PATTERNS = [
  // Actually importing the restart engine or the launchd channel. Editing those
  // files, or running the plugin's own test suite, MUST stay allowed: a guard
  // that blocks maintenance of the very plugin that installs it is worse than
  // no guard, and it deadlocks the agent fixing it.
  /import\(\s*["'][^"']*\/lib\/(?:core|channel)\.js["']\s*\)/,
  /require\(\s*["'][^"']*\/lib\/(?:core|channel)\.js["']\s*\)/,
  /from\s+["'][^"']*\/lib\/(?:core|channel)\.js["']/,
  /new\s+RestartChannel\s*\(/,
  // Running the restart helper, or driving launchd by hand.
  /launchctl\s+(?:bootstrap|kickstart|submit|load)\b/,
  /(?:^|[\s;&|"'=(])(?:~|\$HOME|\/Users\/[^\s"']+)?\/?[\w./-]*dsh-restart(?:\.sh)?(?=[\s"')]|$)/,
  /pkill\s+-f\s+[\s\S]{0,80}(?:DeepSeek|dsh)/,
  /osascript[\s\S]{0,120}?quit/i,
  // Inline JS that would schedule a restart, but only when node actually runs
  // it. A test file merely mentioning the name is documentation, not a bypass.
  /\bnode\b[\s\S]{0,4000}?\.scheduleRestart\s*\(/,
]

/**
 * Does this bash command try to restart the Host without the ledger?
 * @param command - the shell command an agent is about to run.
 * @returns the matching pattern description, or undefined when it is safe.
 */
export function restartBypass(command) {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  for (const pattern of BYPASS_PATTERNS) {
    if (pattern.test(command)) return pattern.source
  }
  return undefined
}

/**
 * Mount the plugin.
 * @param ctx - Cordis context.
 * @param config - plugin configuration.
 * @returns an optional async disposer.
 */
export async function apply(ctx, config) {
  const logger = ctx.logger?.('dsh-hot-restart') ?? ctx.logger

  // Everything below runs inside one try: a restart helper must never cost the
  // operator their app. If any step throws, the plugin reports it and returns a
  // no-op disposer instead of rejecting `apply`, which would fail its activation
  // and (because the loader audits activations) can take the whole startup down.
  let engine
  try {
    const settings = resolveConfig(config)
    const dataDir = resolveDataDir(config)
    ensureDir(dataDir)
    engine = new HotRestart({ ctx, logger, config: settings, dataDir })
    engine.load()
    engine.start(settings.wakePollMs)

    const disposers = []
    if (config?.ui !== false) {
      disposers.push(mountPanel(ctx, engine, logger))
    }
    if (config?.tools !== false) {
      disposers.push(mountTool(ctx, engine, logger))
    }
    if (config?.guardBypass !== false) {
      disposers.push(mountBypassGuard(ctx, logger))
    }
    if (config?.systemPrompt !== false) {
      try {
        ctx.get?.('systemPrompt')?.section({
          name: 'tool:dsh-hot-restart',
          order: 169,
          text: SYSTEM_PROMPT_TEXT,
        })
      } catch (error) {
        logger?.warn?.(`could not register the system prompt section: ${String(error)}`)
      }
    }

    // The wake is owed across boots, so it must be attempted even when nothing
    // else triggers: this is the "after the restart, resume the work" half.
    const kick = setTimeout(() => {
      void engine.runWake().catch((error) => logger?.warn?.(`initial wake failed: ${String(error)}`))
    }, 400)
    kick?.unref?.()

    return async () => {
      clearTimeout(kick)
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {}
      }
      engine.dispose()
    }
  } catch (error) {
    // Deliberately swallowed: see the comment at the top of this function.
    logger?.warn?.(`hot restart disabled after a startup error: ${String(error)}`)
    try {
      engine?.dispose()
    } catch {}
    return async () => {}
  }
}

/**
 * Register the panel RPC channel.
 *
 * The `extend` dance is load-bearing: `connection.rpc.handle` registers its
 * HTTP route through the *reading* context's `webServer`, and `ctx.inject([...])`
 * only makes a service resolvable, not owned. Skipping the `extend` produces
 * `cannot get property "webServer" without inject`, the channel never
 * registers, and every panel POST falls through to the static handler (405).
 *
 * @param ctx - Cordis context.
 * @param engine - the engine.
 * @param logger - optional logger.
 * @returns a disposer.
 */
function mountPanel(ctx, engine, logger) {
  let dispose
  ctx.inject(['connection'], (scope) => {
    const connection = scope?.connection ?? scope?.get?.('connection')
    const register =
      typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined
    if (register === undefined) {
      logger?.warn?.('connection service has no fetch.register; the hot-restart panel routes are not mounted')
      return
    }
    const handler = createViewHandler(engine, { logger })
    dispose = scope.effect(
      () =>
        register({
          path: VIEW_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let endpoint = ''
            let payload = null
            try {
              const body = await request.json()
              endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
              payload = body?.payload ?? null
            } catch {
              return jsonResponse(400, { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } })
            }
            const result = await handler(endpoint, payload)
            return jsonResponse(200, result)
          },
        }),
      'dsh-hot-restart: panel route',
    )
  })
  return async () => {
    try {
      dispose?.()
    } catch {}
  }
}

/**
 * Refuse bash commands that restart the Host outside the ledger.
 *
 * The system prompt asks for this; a prompt is advisory. This hook is the
 * enforcement, and it exists because a hand-written script already stranded a
 * conversation: it called `scheduleRestart` directly with only its own session,
 * so the process died with no record of the conversation it interrupted.
 *
 * A refusal is returned as a tool result rather than thrown, so the agent sees
 * an actionable message instead of a crashed turn.
 *
 * @param ctx - Cordis context.
 * @param logger - optional logger.
 * @returns a disposer.
 */
function mountBypassGuard(ctx, logger) {
  let dispose
  try {
    // `tools/pre-execute` is the documented waterfall gate: returning
    // `{ kind: 'deny', reason }` turns the call into a tool error the agent can
    // read, without crashing the turn.
    const handler = (exec, next) => {
      // The execution object exposes the tool name as `exec.name` (verified
      // against dsh-tool-jobs, which gates on `exec.name === "job_output"`).
      const name = typeof exec?.name === 'string' ? exec.name : ''
      if (name !== 'bash' && name !== 'bash-persistent') return next()
      const args = exec?.args ?? exec?.input ?? exec?.arguments ?? {}
      const matched = restartBypass(typeof args?.command === 'string' ? args.command : '')
      if (matched === undefined) return next()
      logger?.warn?.(`blocked a restart bypass in ${name}: ${matched}`)
      return Promise.resolve({
        kind: 'deny',
        reason: [
          'Blocked: this command would restart the DSH Host without the durable ledger,',
          'which strands every conversation the restart interrupts.',
          'Call the `hot_restart` tool instead — it records all interrupted conversations',
          'before the process dies and resumes all of them afterwards.',
        ].join(' '),
      })
    }
    ctx.on('tools/pre-execute', handler, { prepend: true })
    dispose = () => {
      try {
        ctx.off?.('tools/pre-execute', handler)
      } catch {}
    }
  } catch (error) {
    logger?.warn?.(`restart-bypass guard unavailable: ${String(error)}`)
  }
  return async () => {
    try {
      dispose?.()
    } catch {}
  }
}

/**
 * Register the `hot_restart` agent tool.
 *
 * The tool derives its target from the executing agent's own session, which is
 * the strongest possible "do not wake the wrong conversation" guarantee: the
 * caller does not get to name a session at all.
 *
 * @param ctx - Cordis context.
 * @param engine - the engine.
 * @param logger - optional logger.
 * @returns a disposer.
 */
function mountTool(ctx, engine, logger) {
  let dispose
  let cancelled = false
  // Deliberately NOT awaited: `tools` is provided later in the boot sequence
  // than this plugin, so awaiting it inside `apply` would stall activation (and
  // could deadlock the very plugin that provides it). The panel and the restart
  // machinery must work whether or not the tool lands.
  try {
    const atApply = ctx.get?.('tools')
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx?.tools ?? toolCtx?.get?.('tools')
      if (tools === undefined || typeof tools.register !== 'function') {
        return
      }
      defineToolRegistration(tools).then(
        (result) => {
          if (cancelled) {
            void result?.()
            return
          }
          dispose = result
        },
        (error) => logger?.warn?.(`could not register the hot_restart tool: ${String(error)}`),
      )
    })
  } catch (error) {
  }
  return async () => {
    cancelled = true
    try {
      await dispose?.()
    } catch {}
  }

  /**
   * Build and register the tool definition against a live tools runtime.
   * @param tools - the tools service.
   * @returns a disposer.
   */
  async function defineToolRegistration(tools) {
    let dispose
    try {
      // `tools.register` takes a COMPLETE ToolDefinition: `parameters` is a JSON
      // Schema object (not a field-spec map) and `output` carries both the schema
      // and the renderer. The live service has no `defineTool`, so looking for one
      // — as an earlier build did — silently produced no tool at all.
      const definition = {
        name: 'hot_restart',
        description:
          'Restart the DSH Harness process and, after it comes back, resume every conversation that was interrupted mid-task (including THIS one) with a message telling it the restart completed. Use after installing or updating a plugin that needs the Host reloaded. The current turn ends when the process dies, so summarise state before calling.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              description: 'Short, operator-facing reason for the restart, echoed back in the wake message.',
            },
            prompt: {
              type: 'string',
              description:
                'Optional instructions delivered ONLY to this conversation. Other conversations are never given this text: each receives its own continuation derived from its own last activity, so a restart cannot hijack an unrelated task.',
            },
            allConversations: {
              type: 'boolean',
              description:
                'Wake every conversation that was interrupted mid-task, not only this one. Defaults to true, which is what "restart and keep all my running conversations going" means.',
            },
            sessionIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional exact conversation ids to wake alongside this one.',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scheduled: { type: 'boolean' },
              sessionId: { type: 'string' },
              wakeId: { type: 'string' },
              sessionIds: { type: 'array', items: { type: 'string' } },
              refused: { type: 'array', items: { type: 'string' } },
              detail: { type: 'string' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value?.scheduled
                ? [
                    `Restart scheduled (wake ${value.wakeId}).`,
                    `Will resume ${value.sessionIds?.length ?? 1} conversation(s):`,
                    ...(value.sessionIds ?? [value.sessionId]).map((id) => `  - ${id}`),
                    ...(value.refused?.length ? [`Refused (not woken): ${value.refused.join(', ')}`] : []),
                  ].join('\n')
                : `Restart not scheduled: ${value?.detail ?? 'unknown reason'}`,
            },
          ],
        },
        timeoutMs: 20_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          // The caller's own session is always a target, so a restart can never
          // silently leave the asking conversation behind.
          const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { scheduled: false, detail: 'this tool must run inside an agent session' }
          }
          try {
            const targets = [sessionId]
            if (Array.isArray(args?.sessionIds)) {
              for (const extra of args.sessionIds) {
                if (typeof extra === 'string' && extra.trim() !== '' && !targets.includes(extra.trim())) {
                  targets.push(extra.trim())
                }
              }
            }
            // The engine adds every conversation it finds mid-task unless
            // `allConversations` is false, so the tool only forwards the flag.
            const scheduled = await engine.scheduleRestart({
              // `sessionId` identifies the CALLER: only it receives `prompt`.
              // Without this the engine cannot tell which conversation asked,
              // and the operator's wording leaked to every other one.
              sessionId,
              sessionIds: targets.filter((id) => id !== sessionId),
              allConversations: args?.allConversations !== false,
              reason: typeof args?.reason === 'string' ? args.reason : undefined,
              prompt: typeof args?.prompt === 'string' ? args.prompt : undefined,
              requestId: `hot-restart-${randomBytes(8).toString('hex')}`,
              requestedBy: 'tool',
            })
            return {
              scheduled: true,
              sessionId: scheduled.pending.sessionId,
              wakeId: scheduled.pending.wakeId,
              sessionIds: scheduled.pendingWakes.map((pending) => pending.sessionId),
              refused: scheduled.refused.map((entry) => entry.sessionId),
            }
          } catch (error) {
            return { scheduled: false, detail: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      dispose = tools.register(definition)
    } catch (error) {
      return async () => {}
    }
    return async () => {
      try {
        dispose?.()
      } catch {}
    }
  }
}

/**
 * Package metadata for the Host.
 * @returns name and version.
 */
export function meta() {
  return { name, version: '0.1.0' }
}
