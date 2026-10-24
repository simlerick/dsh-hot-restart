/**
 * Restart channels: how this Host can actually be restarted.
 *
 * Two very different mechanisms exist, and which one is available depends on
 * the desktop shell, not on the plugin:
 *
 * - **renderer IPC** — `window.dshDesktop.restartHarness()`. Only the Windows
 *   desktop shell exposes it. The macOS 0.2.0-rc.2 build has no
 *   `restartHarness`, no `harness:restart` IPC and no restart `ipcMain.handle`
 *   at all (verified against its `app.asar`); the only `app.relaunch()` calls in
 *   that build belong to the crash-recovery dialog and to a development-only
 *   menu item.
 *
 * - **launchd helper** — the only option on macOS. A direct `pkill` + `open`
 *   started from inside the app does not work: the shell kills its own process
 *   group on exit, so the helper dies before it can reopen anything. A launchd
 *   job lives outside that group and survives long enough to reopen the app.
 *
 * The helper this module generates is **one-shot on purpose**. Earlier attempts
 * at this problem left `RunAtLoad=true` agents behind, and every later
 * `launchctl bootstrap` of the same label re-ran them, which looked like the app
 * restarting itself at random. So:
 *
 *   1. the label is per-request (`com.dsh.hotrestart.<token>`), never reused;
 *   2. the job boots itself out and deletes its own plist *before* touching the
 *      app, so nothing can re-trigger it;
 *   3. nothing is left on disk once it has run.
 *
 * @module dsh-hot-restart/channel
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RESTART_CHANNEL, pickRestartChannel } from './pure.js'

/** Directory the generated one-shot helpers are written to. */
export const HELPER_DIR = join(homedir(), 'Library', 'LaunchAgents')

/** Prefix every generated helper label starts with. */
export const HELPER_PREFIX = 'com.dsh.hotrestart.'

/**
 * Operator-provided restart helpers, in preference order.
 *
 * The plugin never creates these. An existing `dsh-restart` belongs to the
 * operator and may carry its own conventions, so it is honoured rather than
 * overwritten — but only when explicitly preferred (see `useOperatorScript`),
 * because ours is the one guaranteed to be one-shot.
 */
export const DEFAULT_RESTART_SCRIPTS = [
  join(homedir(), 'bin', 'dsh-restart'),
  '/usr/local/bin/dsh-restart',
  '/opt/homebrew/bin/dsh-restart',
]

/** Absolute path of the app bundle to reopen. */
export const DEFAULT_APP_PATH = '/Applications/DeepSeek Harness.app'

/** Process-name fragment that identifies the desktop shell. */
export const DEFAULT_PROCESS_PATTERN = 'MacOS/DeepSeek Harness'

/**
 * Find the first executable restart helper.
 * @param candidates - absolute paths to probe.
 * @returns the usable path, or undefined.
 */
export function findRestartScript(candidates = DEFAULT_RESTART_SCRIPTS) {
  for (const path of candidates) {
    try {
      accessSync(path, fsConstants.X_OK)
      return path
    } catch {}
  }
  return undefined
}

/**
 * Build the one-shot launchd job that restarts the desktop shell.
 *
 * The ordering is the whole trick: `bootout` and the plist removal happen
 * *first*, so the job cannot be re-triggered by anything that walks
 * `~/Library/LaunchAgents` afterwards, and only then does it kill and reopen
 * the app.
 *
 * @param options - paths and timings.
 * @returns the shell script body.
 */
export function buildHelperScript(options = {}) {
  const app = options.appPath ?? DEFAULT_APP_PATH
  const pattern = options.processPattern ?? DEFAULT_PROCESS_PATTERN
  const plist = options.plistPath ?? ''
  const label = options.label ?? ''
  const delay = Number.isFinite(options.delaySeconds) ? options.delaySeconds : 1
  const uid = typeof options.uid === 'number' ? options.uid : process.getuid?.() ?? 501
  return [
    '#!/bin/bash',
    '# One-shot DSH restart helper. Deletes itself before touching the app so',
    '# nothing can re-trigger this restart a second time.',
    'set -u',
    `LABEL=${JSON.stringify(label)}`,
    `PLIST=${JSON.stringify(plist)}`,
    `APP=${JSON.stringify(app)}`,
    `PAT=${JSON.stringify(pattern)}`,
    `UID_NUM=${uid}`,
    `DELAY=${delay}`,
    '',
    '# 1. Remove the plist and script BEFORE restarting anything, so nothing',
    '#    can re-trigger this restart. Do NOT `launchctl bootout` from here:',
    '#    bootout kills the job that is currently running this script, which',
    '#    ends the helper before it can reopen the app. Deleting the plist is',
    '#    what makes it one-shot; `LaunchOnlyOnce` already stops it re-running.',
    'if [ -n "$PLIST" ]; then rm -f "$PLIST" 2>/dev/null || true; fi',
    'if [ -n "$PLIST" ]; then rm -f "${PLIST%.plist}.sh" 2>/dev/null || true; fi',
    'sleep "$DELAY"',
    '',
    '# 2. Stop the shell.',
    'pkill -9 -f "$PAT" >/dev/null 2>&1 || true',
    'for _ in $(seq 1 20); do',
    '  pgrep -f "$PAT" >/dev/null 2>&1 || break',
    '  sleep 0.5',
    '  pkill -9 -f "$PAT" >/dev/null 2>&1 || true',
    'done',
    'sleep 1',
    '',
    '# 3. Reopen it.',
    'open "$APP" >/dev/null 2>&1 || exit 1',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Build the launchd property list for one helper.
 * @param options - label, script path and log path.
 * @returns the plist document.
 */
export function buildHelperPlist(options = {}) {
  const label = options.label ?? 'com.dsh.hotrestart'
  const script = options.scriptPath ?? ''
  const logPath = options.logPath ?? ''
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/bash</string>',
    `    <string>${script}</string>`,
    '  </array>',
    // RunAtLoad is what starts the job the moment it is bootstrapped — which is
    // exactly when we want it to run, and never again, because the script
    // removes this file and boots the job out before doing any work.
    '  <key>RunAtLoad</key><true/>',
    '  <key>LaunchOnlyOnce</key><true/>',
  ]
  if (logPath !== '') {
    lines.push(`  <key>StandardOutPath</key><string>${logPath}</string>`)
    lines.push(`  <key>StandardErrorPath</key><string>${logPath}</string>`)
  }
  lines.push('</dict>', '</plist>', '')
  return lines.join('\n')
}

/**
 * Write a fresh one-shot helper and hand it to launchd.
 *
 * Returns as soon as the job is bootstrapped: the app is about to be killed, so
 * waiting for the script would mean never returning.
 *
 * @param options - logger, app path, and timing overrides.
 * @returns `{ ok, detail, label?, plist? }`.
 */
export function scheduleLaunchdRestart(options = {}) {
  const logger = options.logger
  const uid = typeof options.uid === 'number' ? options.uid : process.getuid?.() ?? 501
  const dir = options.helperDir ?? HELPER_DIR
  const token = randomBytes(6).toString('hex')
  const label = `${HELPER_PREFIX}${token}`
  const plistPath = join(dir, `${label}.plist`)
  const scriptPath = join(dir, `${label}.sh`)
  const logPath = options.logPath ?? join(homedir(), 'Library', 'Logs', 'dsh-hot-restart.log')
  try {
    const script = buildHelperScript({
      appPath: options.appPath ?? DEFAULT_APP_PATH,
      processPattern: options.processPattern ?? DEFAULT_PROCESS_PATTERN,
      plistPath,
      label,
      uid,
      delaySeconds: options.delaySeconds,
    })
    writeFileSync(scriptPath, script, { mode: 0o755 })
    writeFileSync(plistPath, buildHelperPlist({ label, scriptPath, logPath }), { mode: 0o644 })
    const child = execFile(
      'launchctl',
      ['bootstrap', `gui/${uid}`, plistPath],
      { stdio: 'ignore', detached: true },
      (error) => {
        if (error) logger?.warn?.(`launchctl bootstrap failed: ${error.message}`)
      },
    )
    child.unref?.()
    logger?.info?.(`scheduled a one-shot restart via ${label}`)
    return { ok: true, detail: `scheduled via ${label}`, label, plist: plistPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`could not schedule the restart helper: ${message}`)
    return { ok: false, detail: message }
  }
}

/**
 * Run an operator-provided restart helper.
 *
 * The helper schedules itself and returns immediately; the actual
 * kill-and-reopen happens under launchd, outside this process group. Awaiting it
 * would therefore be pointless *and* wrong: the app dies while we wait.
 *
 * @param script - absolute path to the helper.
 * @param options - logger and environment overrides.
 * @returns `{ ok, detail }`.
 */
export function runLaunchdRestart(script, options = {}) {
  const logger = options.logger
  const delay = Number.isFinite(options.delaySeconds) ? options.delaySeconds : 8
  try {
    const child = execFile(
      script,
      [],
      {
        env: { ...process.env, DSH_RESTART_DELAY: String(delay) },
        // Detached so a teardown of this process does not take the helper with
        // it; the helper is what reopens the app.
        detached: true,
        stdio: 'ignore',
      },
      (error) => {
        if (error) logger?.warn?.(`restart helper failed: ${error.message}`)
      },
    )
    child.unref?.()
    logger?.info?.(`scheduled a restart through ${script} (delay ${delay}s)`)
    return { ok: true, detail: `scheduled via ${script}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`could not run the restart helper: ${message}`)
    return { ok: false, detail: message }
  }
}

/**
 * Remove helpers this plugin left behind by an interrupted run.
 *
 * A scheduled restart whose boot never happened (the operator cancelled, or the
 * Host died first) leaves a plist on disk. They are inert — a fresh label per
 * request plus `LaunchOnlyOnce` means they never fire again — but they are still
 * litter, and an operator who sees them will reasonably suspect the plugin.
 *
 * Only files this plugin wrote are touched: the content check keeps an
 * operator's own launch agents safe.
 *
 * @param dir - directory to sweep.
 * @returns the removed file names.
 */
export function sweepStaleHelpers(dir = HELPER_DIR) {
  const removed = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return removed
  }
  for (const name of entries) {
    if (!name.startsWith(HELPER_PREFIX)) continue
    const path = join(dir, name)
    try {
      if (name.endsWith('.plist')) {
        const content = readFileSync(path, 'utf8')
        if (!content.includes(HELPER_PREFIX)) continue
      }
      rmSync(path, { force: true })
      removed.push(name)
    } catch {}
  }
  return removed
}

/**
 * Describe and drive the restart capability of this Host.
 */
export class RestartChannel {
  /**
   * @param options - wiring.
   * @param options.logger - optional logger.
   * @param options.scripts - operator helper paths to probe.
   * @param options.platform - override for tests.
   * @param options.appPath - app bundle to reopen.
   * @param options.helperDir - where generated helpers are written.
   * @param options.useOperatorScript - prefer an existing helper over ours.
   */
  constructor(options = {}) {
    this.logger = options.logger
    this.platform = options.platform ?? process.platform
    this.script = findRestartScript(options.scripts)
    this.appPath = options.appPath ?? DEFAULT_APP_PATH
    this.helperDir = options.helperDir ?? HELPER_DIR
    this.processPattern = options.processPattern ?? DEFAULT_PROCESS_PATTERN
    this.useOperatorScript = options.useOperatorScript === true
    this.uid = options.uid
    this.lastLabel = undefined
    /** Set by the renderer once it probes `window.dshDesktop`. */
    this.rendererBridge = undefined
  }

  /**
   * Record what the renderer reported about its bridge.
   * @param present - whether `restartHarness` exists.
   */
  noteRendererBridge(present) {
    this.rendererBridge = present === true
  }

  /**
   * Whether this Host can restart itself at all.
   * @returns true when some mechanism exists.
   */
  canRestart() {
    return this.active() !== RESTART_CHANNEL.none
  }

  /**
   * The channel that can restart this Host right now.
   * @returns a {@link RESTART_CHANNEL} value.
   */
  active() {
    return pickRestartChannel({
      hasRendererBridge: this.rendererBridge === true,
      // Our own helper needs no pre-existing script: it is generated on demand.
      // What it does need is the app bundle to reopen.
      hasRestartScript: this.script !== undefined || (this.platform === 'darwin' && existsSync(this.appPath)),
    })
  }

  /**
   * Everything the panel needs to explain itself.
   * @returns a serializable capability snapshot.
   */
  describe() {
    const channel = this.active()
    const generated = this.script === undefined || this.useOperatorScript !== true
    return {
      channel,
      platform: this.platform,
      rendererBridge: this.rendererBridge,
      script: this.script ?? null,
      app: this.appPath,
      helper: channel !== RESTART_CHANNEL.launchd ? null : generated ? 'generated' : 'operator',
      // The panel shows this verbatim when it cannot restart.
      hint:
        channel === RESTART_CHANNEL.none
          ? 'No restart channel is available: this desktop build exposes no restartHarness bridge, and no way to reopen the app was found.'
          : channel === RESTART_CHANNEL.launchd
            ? generated
              ? 'macOS: a one-shot launchd helper restarts the app outside its process group, then deletes itself.'
              : 'macOS: the restart is delegated to the operator-provided dsh-restart helper.'
            : 'The desktop shell provides an official restart entry.',
    }
  }

  /**
   * Ask for a restart through whichever channel is available.
   *
   * The renderer channel is driven by the renderer itself (it polls the Host and
   * then calls the bridge); the Host only reports that the dispatch is due. The
   * launchd channel is driven from here, because it needs no renderer.
   *
   * @returns `{ ok, channel, detail }`.
   */
  dispatch() {
    const channel = this.active()
    if (channel === RESTART_CHANNEL.launchd) {
      // An operator helper wins only when explicitly asked for: it is their
      // convention, and it may carry extra behaviour we must not bypass.
      if (this.useOperatorScript && this.script !== undefined) {
        const result = runLaunchdRestart(this.script, { logger: this.logger })
        return { ...result, channel }
      }
      const result = scheduleLaunchdRestart({
        logger: this.logger,
        appPath: this.appPath,
        processPattern: this.processPattern,
        helperDir: this.helperDir,
        uid: this.uid,
      })
      if (result.ok) this.lastLabel = result.label
      return { ...result, channel }
    }
    if (channel === RESTART_CHANNEL.rendererIpc) {
      // The renderer performs this; nothing to do here.
      return { ok: true, channel, detail: 'delegated to the renderer' }
    }
    return { ok: false, channel, detail: 'no restart channel available' }
  }
}
