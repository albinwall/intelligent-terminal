// Intelligent Terminal features for Claude Code.
// Talks to the terminal through wtcli.exe, which ships with Intelligent Terminal.

const WTCLI = 'wtcli.exe'
const PREFIX = 'mcp__terminal__'
const NO_PROMPT_TOOLS = new Set(['panes', 'read', 'profiles', 'resolve_command', 'focus'])

const INTRO = `You are running inside Intelligent Terminal (Windows Terminal with agent support), most likely in the agent pane under the user's shell. The mcp__terminal__ tools let you see and use the terminal:
- panes lists windows, tabs and panes. read reads a pane's screen, or just its last command and output.
- run types a command into one of the user's panes (they approve it first) and can wait for the result.
- open opens a new tab or split, with an optional command, folder or profile. delegate starts another Claude in a new tab or split with a task.
- profiles lists terminal profiles. resolve_command shows what a command name resolves to for a folder and shell. focus and close act on a pane.
Each user message comes with a short "Terminal" note about the pane the user is working in. Use that pane's shell syntax and folder for commands meant for it. Your own Bash or PowerShell tool runs in a separate process and doesn't change that pane. Use run when the user wants something done in their pane; for questions, just answer.`

const FIX = `My last command failed. Work out what I was trying to do and why it failed, fix whatever needs fixing, then give me the corrected command with the terminal run tool so I can approve it. If it's an obvious typo, go straight to the corrected command. If you can't tell what I want, ask me. Your own shell is separate from that pane, so changes you make there don't affect it.`

const EXPLAIN = `Explain why my last command failed. Don't run or change anything.`

let selfPane = ''
let ownTab = null // { at, windowId, tabIndex, panes, isAgentPane }
let tabStableId = ''
let lastShellPane = ''
let failure = null // { pane, rawPane, code, summary, output, shell, cwd, dismissed }
let fixPending = false
let introSent = false
let listening = false
const lastExit = new Map()
const doneCount = new Map()

// ---------- helpers ----------

function norm(id) {
  return String(id ?? '').replace(/[{}]/g, '').toUpperCase()
}

function clip(text, max) {
  const s = String(text ?? '').trimEnd()
  return s.length > max ? '...' + s.slice(s.length - max) : s
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(l => l) ?? ''
}

// Windows command line quoting for one argument.
function quoteArg(s) {
  if (s && !/[\s"]/.test(s)) return s
  let out = '"'
  let slashes = 0
  for (const ch of s) {
    if (ch === '\\') { slashes++; continue }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

async function wt($, args, stdin) {
  try {
    const r = await $.process.run([WTCLI, '--json', ...args], stdin ? { stdin, timeoutMs: 10000 } : { timeoutMs: 10000 })
    if (r.exitCode !== 0) return { error: (r.stderr || r.stdout || 'wtcli failed').trim() }
    try { return JSON.parse(r.stdout) } catch { return { text: r.stdout } }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

// Find the tab this session's pane is in. Cached for a few seconds.
async function findOwnTab($, fresh) {
  if (!selfPane) return null
  if (!fresh && ownTab && Date.now() - ownTab.at < 3000) return ownTab
  const wins = await wt($, ['list-windows'])
  for (const w of wins.windows ?? []) {
    const tabs = await wt($, ['list-tabs', '-w', String(w.window_id)])
    for (const t of tabs.tabs ?? []) {
      if (!t.pane_count) continue
      const list = await wt($, ['list-panes', '-w', String(w.window_id), '-t', String(t.tab_id)])
      const panes = list.panes ?? []
      const me = panes.find(p => norm(p.session_id) === selfPane)
      if (me) {
        ownTab = { at: Date.now(), windowId: w.window_id, tabIndex: t.tab_id, panes, isAgentPane: !!me.is_agent_pane }
        return ownTab
      }
    }
  }
  // A hidden agent pane isn't in any tab. Keep what we knew.
  if (ownTab) ownTab.at = Date.now()
  return ownTab
}

async function paneInOwnTab($, pane) {
  let tab = await findOwnTab($, false)
  if (tab && tab.panes.some(p => norm(p.session_id) === pane)) return true
  tab = await findOwnTab($, true)
  return !!tab && tab.panes.some(p => norm(p.session_id) === pane)
}

function paneInfo(pane) {
  return ownTab?.panes.find(p => norm(p.session_id) === pane) ?? null
}

// The shell pane the user is working with: the active pane, or when that's
// this session's own pane, the last shell pane in this tab.
async function sourcePane($) {
  const active = await wt($, ['active-pane'])
  if (active.session_id && norm(active.session_id) !== selfPane && !active.is_agent_pane) return active
  const tab = await findOwnTab($, true)
  const others = (tab?.panes ?? []).filter(p => norm(p.session_id) !== selfPane && !p.is_agent_pane)
  return others.find(p => norm(p.session_id) === lastShellPane) ?? others[0] ?? null
}

async function terminalNote($) {
  const p = await sourcePane($)
  if (!p) return ''
  const pane = norm(p.session_id)
  let note = `Terminal: the user's pane is ${pane} "${p.title ?? ''}", ${p.shell ?? 'unknown shell'}${p.shell_version ? ' ' + p.shell_version : ''} in ${p.cwd ?? 'an unknown folder'}.`
  const last = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', '30'])
  if (last.has_marks && last.content) {
    const code = lastExit.get(pane)
    note += `\nIts last command${code === undefined ? '' : ` (exit ${code})`}:\n${clip(last.content, 1500)}`
  }
  return note
}

async function publishFixState($, params) {
  if (!ownTab?.isAgentPane || !tabStableId) return
  const evt = JSON.stringify({ type: 'event', method: 'autofix_state', params: { ...params, tab_id: tabStableId } })
  try {
    await $.process.run([WTCLI, 'publish', '--existing-only', '--stdin'], { stdin: evt, timeoutMs: 5000 })
  } catch {
    // Terminal isn't there; nothing to update.
  }
}

function describeFailure(f) {
  return `Pane: ${f.pane} (${f.shell || 'unknown shell'}, ${f.cwd || 'unknown folder'})\nExit code: ${f.code}\nCommand and output:\n\`\`\`\n${f.output}\n\`\`\``
}

async function failureFromPane($, pane, code) {
  await findOwnTab($, false)
  const cap = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', '60'])
  let output = cap.content ?? ''
  if (!cap.has_marks) {
    const tail = await wt($, ['capture-pane', '-t', pane, '-l', '40'])
    output = tail.content ?? ''
  }
  const info = paneInfo(pane)
  const cmd = firstLine(output).replace(/^.*?>\s*/, '') || 'The last command'
  return {
    pane,
    code: code ?? lastExit.get(pane) ?? 1,
    summary: `${clip(cmd, 60).replace(/^\.\.\./, '')} failed (exit ${code ?? lastExit.get(pane) ?? 1})`,
    output: clip(output, 3000),
    shell: info?.shell ?? '',
    cwd: info?.cwd ?? '',
    dismissed: false,
  }
}

function startFix($, f, mode, hint) {
  if (!f) return
  f.dismissed = true
  $.ui.invalidate('ui.render')
  const text = `${mode === 'explain' ? EXPLAIN : FIX}${hint ? `\nMy note: ${hint}` : ''}\n\n${describeFailure(f)}`
  if (mode !== 'explain') {
    fixPending = true
    publishFixState($, { state: 'pending', pane_id: f.rawPane ?? f.pane, summary: f.summary })
  }
  $.prompt.submit({ text, asUser: true })
}

function dismissFailure($) {
  if (failure) failure.dismissed = true
  $.ui.invalidate('ui.render')
  publishFixState($, { state: 'cleared' })
}

// ---------- terminal events ----------

async function onEvent($, line) {
  let evt
  try { evt = JSON.parse(line) } catch { return }
  const method = evt.method ?? ''
  const p = evt.params ?? {}

  if (method === 'vt_sequence') {
    const seq = String(p.sequence ?? '')
    if (!seq.startsWith('osc:133;')) return
    const pane = norm(p.pane_id)
    if (!pane || pane === selfPane) return
    if (!(await paneInOwnTab($, pane))) return
    if (p.tab_id) tabStableId = String(p.tab_id)
    lastShellPane = pane
    if (!seq.startsWith('osc:133;D')) return
    const code = parseInt(seq.split(';')[2] ?? '0', 10) || 0
    lastExit.set(pane, code)
    doneCount.set(pane, (doneCount.get(pane) ?? 0) + 1)
    if (code !== 0) {
      failure = await failureFromPane($, pane, code)
      failure.rawPane = String(p.pane_id)
      $.ui.invalidate('ui.render')
      publishFixState($, { state: 'detected', pane_id: failure.rawPane, summary: failure.summary, hotkey_hint: 'Ctrl+Alt+.' })
    } else if (failure && failure.pane === pane) {
      failure = null
      $.ui.invalidate('ui.render')
      publishFixState($, { state: 'cleared' })
    }
    return
  }

  // The terminal's "fix with agent" button and Ctrl+Alt+.
  if (method === 'autofix_execute_from_detected') {
    const pane = norm(p.pane_id)
    const ours = (tabStableId && p.tab_id === tabStableId) || (pane && (await paneInOwnTab($, pane)))
    if (!ours) return
    const f = failure && (!pane || failure.pane === pane) ? failure : pane ? await failureFromPane($, pane) : null
    startFix($, f, 'fix', '')
  }
}

async function listen($) {
  for (;;) {
    let buf = ''
    try {
      const events = $.process.spawn({ argv: [WTCLI, '--json', 'listen', '--existing-only'] })
      for await (const chunk of events) {
        if (chunk.stream !== 'stdout') continue
        buf += chunk.text
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) await onEvent($, line)
        }
      }
    } catch {
      // Terminal not running, or the listener stopped. Try again shortly.
    }
    try { await $.clock.sleep(5000) } catch { return }
  }
}

// ---------- tools ----------

async function toolPanes($) {
  const out = []
  const wins = await wt($, ['list-windows'])
  if (wins.error) return wins.error
  for (const w of wins.windows ?? []) {
    const tabs = await wt($, ['list-tabs', '-w', String(w.window_id)])
    for (const t of tabs.tabs ?? []) {
      if (!t.pane_count) continue
      const list = await wt($, ['list-panes', '-w', String(w.window_id), '-t', String(t.tab_id)])
      for (const p of list.panes ?? []) {
        const pane = norm(p.session_id)
        out.push({
          window: w.window_id, tab: t.tab_id, tab_title: t.title, pane, title: p.title,
          shell: p.shell, cwd: p.cwd, profile: p.profile, active: !!p.is_active,
          agent_pane: !!p.is_agent_pane, you: pane === selfPane,
          last_exit: lastExit.get(pane),
        })
      }
    }
  }
  return JSON.stringify(out, null, 1)
}

async function toolRead($, e) {
  const pane = norm(e.pane) || norm((await sourcePane($))?.session_id)
  if (!pane) return 'No pane to read.'
  const lines = Math.min(Math.max(Number(e.lines) || 60, 1), 400)
  if (e.last_command) {
    const last = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', String(lines)])
    if (last.error) return last.error
    if (last.has_marks) return last.content || '(empty)'
  }
  const screen = await wt($, ['capture-pane', '-t', pane, '-l', String(lines)])
  if (screen.error) return screen.error
  const prefix = e.last_command ? 'This pane has no command marks (no shell integration), so here are its last lines instead.\n' : ''
  return prefix + (screen.content || '(empty)')
}

async function toolRun($, e) {
  const command = String(e.command ?? '')
  if (!command) return 'No command given.'
  const pane = norm(e.pane) || norm((await sourcePane($))?.session_id)
  if (!pane) return 'No pane to run it in.'
  if (pane === selfPane) return "That's your own pane. Pick one of the user's panes."
  const before = doneCount.get(pane) ?? 0
  const sent = await wt($, ['send-keys', '-t', pane, '--raw', '--', command])
  if (sent.error) return sent.error
  const enter = await wt($, ['send-keys', '-t', pane, 'Enter'])
  if (enter.error) return enter.error
  if (e.wait === false) return `Sent to pane ${pane}.`
  // Wait a few seconds for the command to finish (needs shell integration).
  for (let waited = 0; waited < 7000 && (doneCount.get(pane) ?? 0) === before; waited += 350) {
    await $.clock.sleep(350)
  }
  if ((doneCount.get(pane) ?? 0) === before) return `Sent to pane ${pane}. It's still running, or the pane has no shell integration. Use read to check on it.`
  const last = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', '80'])
  return `Finished with exit code ${lastExit.get(pane)}.\n${clip(last.content ?? '', 6000)}`
}

async function toolOpen($, e) {
  const args = []
  if (e.where === 'split') {
    const target = norm(e.pane) || norm((await sourcePane($))?.session_id)
    args.push('split-pane', '-d', e.direction || 'auto')
    if (target) args.push('-t', target)
    if (e.size) args.push('-s', String(e.size))
  } else {
    args.push('new-tab')
    if (e.cwd) args.push('-d', e.cwd)
    if (e.title) args.push('-n', e.title)
  }
  if (e.command) args.push('-c', e.command)
  if (e.profile) args.push('-p', e.profile)
  const r = await wt($, args)
  return r.error ?? JSON.stringify(r)
}

async function toolDelegate($, e) {
  const task = String(e.task ?? '').replace(/\r?\n/g, ' ').trim()
  if (!task) return 'No task given.'
  return toolOpen($, { where: e.where, direction: e.direction, cwd: e.cwd, title: e.title, command: `claude ${quoteArg(task)}` })
}

async function toolResolve($, e) {
  const name = String(e.name ?? '').trim()
  if (!name) return 'No command name given.'
  const args = ['resolve-command', name, '--json']
  if (e.cwd) args.push('--cwd', e.cwd)
  if (e.shell) args.push('--shell', e.shell)
  try {
    const r = await $.process.run(['wta.exe', ...args], { timeoutMs: 20000 })
    return (r.stdout || r.stderr || '').trim() || `wta exited with ${r.exitCode}`
  } catch (err) {
    return String(err?.message ?? err)
  }
}

async function runTool($, name, e) {
  if (name === 'panes') return toolPanes($)
  if (name === 'read') return toolRead($, e)
  if (name === 'run') return toolRun($, e)
  if (name === 'open') return toolOpen($, e)
  if (name === 'delegate') return toolDelegate($, e)
  if (name === 'resolve_command') return toolResolve($, e)
  if (name === 'profiles') {
    const r = await wt($, ['list-profiles'])
    return r.error ?? JSON.stringify(r.profiles ?? r, null, 1)
  }
  if (name === 'focus' || name === 'close') {
    const pane = norm(e.pane)
    if (!pane) return 'No pane given.'
    if (name === 'close' && pane === selfPane) return "That's your own pane."
    const r = await wt($, [name === 'focus' ? 'focus-pane' : 'kill-pane', '-t', pane])
    return r.error ?? 'Done.'
  }
  return `Unknown tool ${name}.`
}

async function registerTools($) {
  const pane = { type: 'string', description: 'Pane id from panes. Leave out to use the pane the user is working in.' }
  const tools = [
    { name: 'panes', description: 'List Windows Terminal windows, tabs and panes with shell, folder, title and last exit code. Your own pane is marked "you".', inputSchema: { type: 'object', properties: {} } },
    { name: 'read', description: "Read a terminal pane's screen, or just its last command and output.", inputSchema: { type: 'object', properties: { pane, lines: { type: 'integer', description: 'How many lines, up to 400. Default 60.' }, last_command: { type: 'boolean', description: 'Only the last command and its output (needs shell integration).' } } } },
    { name: 'run', description: "Type a command into one of the user's terminal panes and press Enter. The user approves it first. By default waits a few seconds and returns the output.", inputSchema: { type: 'object', properties: { command: { type: 'string', description: "The command, in that pane's shell syntax." }, pane, wait: { type: 'boolean', description: 'Wait for the result. Default true.' } }, required: ['command'] } },
    { name: 'open', description: 'Open a new terminal tab or split, optionally running a command, in a folder (tabs only) or with a profile.', inputSchema: { type: 'object', properties: { where: { type: 'string', enum: ['tab', 'split'] }, command: { type: 'string' }, cwd: { type: 'string', description: 'Starting folder, for tabs.' }, profile: { type: 'string', description: 'Profile name or GUID from profiles.' }, direction: { type: 'string', enum: ['right', 'left', 'up', 'down', 'auto'] }, size: { type: 'number', description: 'Split size from 0.1 to 0.9.' }, title: { type: 'string' }, pane: { type: 'string', description: 'Pane to split. Default: the pane the user is working in.' } }, required: ['where'] } },
    { name: 'delegate', description: 'Start another Claude Code session in a new tab or split with a task. Give it everything it needs: goal, context, folder and when it is done.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, where: { type: 'string', enum: ['tab', 'split'] }, cwd: { type: 'string' }, direction: { type: 'string', enum: ['right', 'left', 'up', 'down', 'auto'] }, title: { type: 'string' } }, required: ['task'] } },
    { name: 'profiles', description: 'List the terminal profiles (id, name, default, agent).', inputSchema: { type: 'object', properties: {} } },
    { name: 'resolve_command', description: 'Find what a command name resolves to for a folder and shell, with close matches when it is not found.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, cwd: { type: 'string' }, shell: { type: 'string', description: 'For example pwsh.exe, powershell.exe, cmd.exe, bash.' } }, required: ['name'] } },
    { name: 'focus', description: 'Move focus to a terminal pane.', inputSchema: { type: 'object', properties: { pane }, required: ['pane'] } },
    { name: 'close', description: 'Close a terminal pane.', inputSchema: { type: 'object', properties: { pane }, required: ['pane'] } },
  ]
  for (const tool of tools) {
    try { await $.tool.register({ ...tool, isDeferred: false }) } catch { /* already registered */ }
  }
}

// ---------- hooks ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    selfPane = norm(await $.env.get('WT_SESSION'))
    await registerTools($)
    try { await $.command.register({ name: 'fix', description: 'Fix the last failed command in this tab', argumentHint: '[note]' }) } catch { /* taken */ }
    try { await $.command.register({ name: 'panes', description: 'Show the terminal panes', immediate: true }) } catch { /* taken */ }
    if (selfPane && !listening) {
      listening = true
      listen($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') introSent = false
    return next(e)
  })

  // Add the terminal note to each message the user sends.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !selfPane) return next(e)
    const blocks = []
    if (!introSent) {
      blocks.push(INTRO)
      introSent = true
    }
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') {
      const note = await terminalNote($)
      if (note) blocks.push(note)
    }
    if (!blocks.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool ?? '')
    if (!name.startsWith(PREFIX)) return next(e)
    return { result: await runTool($, name.slice(PREFIX.length), e) }
  }).catch(($, e, next) => ({ result: `The terminal tool failed: ${next.error?.message ?? 'unknown error'}` }))

  // Read-only terminal tools don't need a prompt.
  on('tool.check', async ($, e, next) => {
    const name = String(e.tool ?? '')
    if (!name.startsWith(PREFIX) || !NO_PROMPT_TOOLS.has(name.slice(PREFIX.length))) return next(e)
    const decision = await next(e)
    return decision.decision === 'ask' ? { decision: 'allow', reason: 'Read-only terminal tool' } : decision
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'fix' }, async ($, e) => {
    let f = failure
    if (!f) {
      const p = await sourcePane($)
      if (p) f = await failureFromPane($, norm(p.session_id))
    }
    if (!f) return { text: 'No failed command found in this tab.' }
    startFix($, f, 'fix', e.args)
    return {}
  })

  on('command.run', { command: 'panes' }, async ($) => {
    return { text: await toolPanes($) }
  })

  on('turn.complete', async ($, e, next) => {
    if (fixPending && !e.agentId) {
      fixPending = false
      publishFixState($, { state: 'cleared' })
    }
    return next(e)
  })

  // Failed command, shown above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!failure || failure.dismissed) return next(e)
    const f = failure
    const ui = $.ui.resolve(e)
    const row = ui.Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        ui.Text({ color: 'red', wrap: 'truncate', children: ['✗ ' + f.summary] }),
        ui.Button({ key: 'terminal-fix', label: 'Fix', hotkey: '1', plain: true, onPress: () => startFix($, f, 'fix', '') }),
        ui.Button({ key: 'terminal-explain', label: 'Explain', hotkey: '2', plain: true, onPress: () => startFix($, f, 'explain', '') }),
        ui.Button({ key: 'terminal-dismiss', label: 'Dismiss', hotkey: '3', plain: true, onPress: () => dismissFailure($) }),
      ],
    })
    const rest = await next(e)
    return rest ? ui.Box({ flexDirection: 'column', children: [row, rest] }) : row
  })
}
