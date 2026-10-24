/**
 * The restart-bypass guard: the prompt asks agents to use `hot_restart`, and
 * this is what enforces it. A hand-written script already bypassed the tool
 * once and stranded a conversation, so the negative cases matter most.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { restartBypass } from '../lib/index.js'

test('a direct scheduleRestart call is refused', () => {
  const command = `node -e 'import("./lib/core.js").then(async m => {
    const engine = new m.HotRestart({ ctx, dataDir })
    await engine.scheduleRestart({ sessionId: "session-x" })
  })'`
  assert.notEqual(restartBypass(command), undefined)
})

test('a direct RestartChannel dispatch is refused', () => {
  assert.notEqual(restartBypass(`node -e 'new RestartChannel({}).dispatch()'`), undefined)
  assert.notEqual(restartBypass(`node -e 'import("./lib/channel.js").then(m => m.RestartChannel)'`), undefined)
})

test('launchctl and the restart helper are refused', () => {
  assert.notEqual(restartBypass('launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist'), undefined)
  assert.notEqual(restartBypass('launchctl kickstart -k gui/501/com.dsh.app'), undefined)
  assert.notEqual(restartBypass('~/bin/dsh-restart --now'), undefined)
})

test('killing the app by hand is refused', () => {
  assert.notEqual(restartBypass('pkill -f "DeepSeek Harness"'), undefined)
  assert.notEqual(restartBypass(`osascript -e 'tell application "DeepSeek Harness" to quit'`), undefined)
})

test('reading the ledger is allowed', () => {
  assert.equal(restartBypass('cat ~/.dsh/dsh-hot-restart/ledger.json'), undefined)
  assert.equal(restartBypass(`python3 -c "import json;json.load(open(os.path.expanduser('~/.dsh/dsh-hot-restart/ledger.json')))"`), undefined)
})

test('running the plugin test suite is allowed', () => {
  assert.equal(restartBypass('cd ~/dsh/dsh-hot-restart && node --test "test/*.test.js"'), undefined)
})

test('importing the pure helpers is allowed', () => {
  // pure.js cannot restart anything: it is guards and ledger shapes only.
  assert.equal(restartBypass(`node -e 'import("./lib/pure.js").then(m => console.log(m.wakeMarker("w")))'`), undefined)
})

test('ordinary commands are allowed', () => {
  assert.equal(restartBypass('ls -la ~/.dsh/sessions'), undefined)
  assert.equal(restartBypass('git status'), undefined)
  assert.equal(restartBypass(''), undefined)
  assert.equal(restartBypass(undefined), undefined)
})
