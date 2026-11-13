// Intelligent Terminal for Claude Code: tools to see and use the terminal's panes, a note
// about the pane the user works in with each prompt, and a Fix line when a command fails
// in the same tab. The terminal is reached through wtcli.exe, which ships with
// Intelligent Terminal.

const WTCLI = 'wtcli.exe'
const PREFIX = 'mcp__terminal__'
const NO_PROMPT_TOOLS = new Set(['panes', 'read', 'profiles', 'resolve_command', 'focus'])
const MEMORY = 'pane:'

const INTRO = `You are running inside Intelligent Terminal (Windows Terminal with agent support). The mcp__terminal__ tools let you see and use the terminal:
- panes lists windows, tabs and panes, with the agent CLI running in each. read reads a pane's screen, or just its last command and output.
- run types a command into one of the user's shell panes and can wait for the result. type types text into one or more panes and presses Enter, for example a slash command into every pane running Claude Code. keys sends key presses such as Escape, Up, Down or C-c. Both return what the pane shows afterwards.
- open opens a new tab or split, with an optional command, folder or profile. delegate starts another Claude in a new tab or split with a task. handoff hands this session over to a fresh one next to it, after you write your handover.
- profiles lists terminal profiles. resolve_command shows what a command name resolves to for a folder and shell. focus and close act on a pane.
Each user message comes with a short "Terminal" note about the pane the user works in. Use that pane's shell syntax and folder for commands meant for it. Your own Bash or PowerShell tool runs in a separate process and doesn't change that pane. Read a pane before you act on it. Use run when the user wants something done in their pane; for questions, just answer.`

const FIX = `My last command failed. Work out what I was trying to do and why it failed, fix whatever needs fixing, then give me the corrected command with the terminal run tool so I can approve it. If it's an obvious typo, go straight to the corrected command. If you can't tell what I want, ask me. Your own shell is separate from that pane, so changes you make there don't affect it.`

const EXPLAIN = `Explain why my last command failed. Don't run or change anything.`

// Key names for the keys tool, as the bytes a terminal sends for them.
const KEYS = {
  enter: '\r', tab: '\t', 's-tab': '\x1b[Z', escape: '\x1b', esc: '\x1b', bspace: '\x7f', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', ppage: '\x1b[5~', npage: '\x1b[6~', delete: '\x1b[3~', dc: '\x1b[3~', insert: '\x1b[2~', ic: '\x1b[2~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
}

let sessionId = ''
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
const exePaths = new Map()

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

// One key name (Up, C-c, F5) or plain text, as the bytes to send.
function keyBytes(key) {
  const named = KEYS[key.toLowerCase()]
  if (named) return named
  const ctrl = key.match(/^C-(.)$/i)
  if (ctrl) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f)
  return key
}

// Programs started inside an app package (such as the agent pane) can't use the shared
// app alias folder, only each app's own one, so look there when the plain name fails.
async function exe($, name) {
  if (exePaths.has(name)) return exePaths.get(name)
  const candidates = [name]
  const local = await $.env.get('LOCALAPPDATA')
  if (local) {
    const apps = `${local}\\Microsoft\\WindowsApps`
    try {
      for (const entry of await $.fs.list(apps)) {
        if (entry.kind === 'file') continue
        try {
          const inner = await $.fs.list(`${apps}\\${entry.name}`)
          if (inner.some(f => f.name.toLowerCase() === name.toLowerCase())) candidates.push(`${apps}\\${entry.name}\\${name}`)
        } catch {
          // An app folder we can't read.
        }
      }
    } catch {
      // No alias folder; the plain name is all there is.
    }
  }
  for (const candidate of candidates) {
    try {
      const r = await $.process.run([candidate, '--help'], { timeoutMs: 5000 })
      if (r.exitCode === 0) {
        exePaths.set(name, candidate)
        return candidate
      }
    } catch {
      // Not there; try the next one.
    }
  }
  exePaths.set(name, name)
  return name
}

async function wt($, args, stdin) {
  try {
    const r = await $.process.run([await exe($, WTCLI), '--json', ...args], stdin ? { stdin, timeoutMs: 10000 } : { timeoutMs: 10000 })
    if (r.exitCode !== 0) return { error: `${args[0]}: ${(r.stderr || r.stdout || 'wtcli failed').trim()}` }
    try { return JSON.parse(r.stdout) } catch { return { text: r.stdout } }
  } catch (err) {
    return { error: `${args[0]}: ${String(err?.message ?? err)}` }
  }
}

async function screenTail($, pane, lines) {
  const r = await wt($, ['capture-pane', '-t', pane, '-l', String(lines)])
  return r.error ? '' : String(r.content ?? '').split(/\r?\n/).filter(l => l.trim()).join('\n')
}

// ---------- this session's pane and tab ----------

// Find the tab this session's pane is in. Cached for a few seconds.
// Terminal leaves agent panes out of its pane lists, so an agent pane finds its
// tab as the one holding the shell panes it knew, or at the start as the focused tab.
async function findOwnTab($, fresh) {
  if (!selfPane) return null
  if (!fresh && ownTab && Date.now() - ownTab.at < 3000) return ownTab
  const known = new Set((ownTab?.panes ?? []).map(p => norm(p.session_id)))
  let byKnown = null
  const wins = await wt($, ['list-windows'])
  for (const w of wins.windows ?? []) {
    const tabs = await wt($, ['list-tabs', '-w', String(w.window_id)])
    for (const t of tabs.tabs ?? []) {
      if (!t.pane_count) continue
      const list = await wt($, ['list-panes', '-w', String(w.window_id), '-t', String(t.tab_id)])
      const panes = list.panes ?? []
      if (panes.some(p => norm(p.session_id) === selfPane)) {
        ownTab = { at: Date.now(), windowId: w.window_id, tabIndex: t.tab_id, panes, isAgentPane: false }
        return ownTab
      }
      if (!byKnown && panes.some(p => known.has(norm(p.session_id)))) {
        byKnown = { at: Date.now(), windowId: w.window_id, tabIndex: t.tab_id, panes, isAgentPane: true }
      }
    }
  }
  if (byKnown) {
    ownTab = byKnown
    return ownTab
  }
  if (!ownTab) {
    // Not listed and nothing known yet: an agent pane that just opened in the focused tab.
    const active = await wt($, ['active-pane'])
    if (active.session_id && norm(active.session_id) !== selfPane) {
      const list = await wt($, ['list-panes', '-w', String(active.window_id), '-t', String(active.tab_id)])
      ownTab = { at: Date.now(), windowId: active.window_id, tabIndex: active.tab_id, panes: list.panes ?? [], isAgentPane: true }
    }
    return ownTab
  }
  ownTab.at = Date.now()
  return ownTab
}

// Kept so a reload of the mod finds the same tab again.
async function remember($) {
  if (!sessionId || !ownTab) return
  try {
    await $.store.set(MEMORY + sessionId, { wtPane: selfPane, tabPanes: ownTab.panes.map(p => norm(p.session_id)), isAgentPane: !!ownTab.isAgentPane, at: await $.clock.now() })
  } catch {
    // Only a reload needs it.
  }
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

// The pane the user works in: the active pane, or when that's this session's
// own pane, the last shell pane in this tab.
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
  const what = `${pane} "${p.title ?? ''}", ${p.shell ?? 'unknown shell'}${p.shell_version ? ' ' + p.shell_version : ''} in ${p.cwd ?? 'an unknown folder'}`
  let note = ownTab?.isAgentPane
    ? `Terminal: you are in this tab's agent pane (${selfPane}). The pane it is attached to, where the user runs commands, is ${what}.`
    : `Terminal: you are in pane ${selfPane}. The other pane in this tab, where the user runs commands, is ${what}.`
  const last = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', '30'])
  if (last.has_marks && last.content) {
    const code = lastExit.get(pane)
    note += `\nIts last command${code === undefined ? '' : ` (exit ${code})`}:\n${clip(last.content, 1500)}`
  } else {
    // No shell prompt marks: a full-screen program, so show what is on screen now.
    const screen = await screenTail($, pane, 20)
    if (screen) note += `\nWhat it shows now (last lines):\n${clip(screen, 1500)}`
  }
  return note
}

// ---------- failed commands ----------

async function publishFixState($, params) {
  if (!ownTab?.isAgentPane || !tabStableId) return
  const evt = JSON.stringify({ type: 'event', method: 'autofix_state', params: { ...params, tab_id: tabStableId } })
  try {
    await $.process.run([await exe($, WTCLI), 'publish', '--existing-only', '--stdin'], { stdin: evt, timeoutMs: 5000 })
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
  if (!cap.has_marks) output = await screenTail($, pane, 40)
  const info = paneInfo(pane)
  const exit = code ?? lastExit.get(pane) ?? 1
  const cmd = firstLine(output).replace(/^.*?>\s*/, '') || 'The last command'
  return {
    pane,
    code: exit,
    summary: `${clip(cmd, 60).replace(/^\.\.\./, '')} failed (exit ${exit})`,
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
      const events = $.process.spawn({ argv: [await exe($, WTCLI), '--json', 'listen', '--existing-only'] })
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
          agent: p.native_agent_provider_id || undefined, you: pane === selfPane,
          last_exit: lastExit.get(pane),
        })
      }
    }
  }
  // Terminal leaves agent panes out of its lists; add this session's own.
  if (selfPane && !out.some(p => p.you)) {
    out.push({ window: ownTab?.windowId, tab: ownTab?.tabIndex, pane: selfPane, agent: 'claude', agent_pane: !!ownTab?.isAgentPane, you: true })
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
  if ((doneCount.get(pane) ?? 0) === before) return `Sent to pane ${pane}. It's still running, or the pane has no shell integration. Its screen now:\n${clip(await screenTail($, pane, 15), 1500)}`
  const last = await wt($, ['capture-pane', '-t', pane, '--last-prompt', '-l', '80'])
  return `Finished with exit code ${lastExit.get(pane)}.\n${clip(last.content ?? '', 6000)}`
}

async function toolType($, e) {
  const panes = (Array.isArray(e.panes) ? e.panes : [e.panes]).map(norm).filter(p => p)
  const text = String(e.text ?? '')
  if (!panes.length || !text) return 'Give the panes and the text.'
  const out = []
  const sentTo = []
  for (const pane of panes) {
    if (pane === selfPane) { out.push(`${pane}: skipped, that's your own pane`); continue }
    const sent = await wt($, ['send-keys', '-t', pane, '--raw', '--', text])
    if (sent.error) { out.push(`${pane}: ${sent.error}`); continue }
    if (e.enter !== false) {
      const enter = await wt($, ['send-keys', '-t', pane, 'Enter'])
      if (enter.error) { out.push(`${pane}: ${enter.error}`); continue }
    }
    sentTo.push(pane)
  }
  // Show what each pane looks like now, so the next step isn't a guess.
  if (sentTo.length) await $.clock.sleep(800)
  const lines = sentTo.length > 4 ? 6 : 15
  for (const pane of sentTo) {
    out.push(`${pane}: sent. Its screen now:\n${clip(await screenTail($, pane, lines), 1500)}`)
  }
  return out.join('\n\n')
}

async function toolKeys($, e) {
  const pane = norm(e.pane)
  if (!pane) return 'No pane given.'
  if (pane === selfPane) return "That's your own pane."
  const keys = (Array.isArray(e.keys) ? e.keys : [e.keys]).map(String).filter(k => k)
  if (!keys.length) return 'No keys given.'
  // One key at a time, so a program reads Escape and an arrow as two keys.
  for (const key of keys) {
    const r = await wt($, ['send-keys', '-t', pane, '--raw', '--', keyBytes(key)])
    if (r.error) return r.error
  }
  await $.clock.sleep(800)
  return `Sent. Its screen now:\n${clip(await screenTail($, pane, 15), 1500)}`
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

// The command line this Claude Code process was started with, to start the next one alike.
async function ownLaunch($) {
  const script = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; for ($i = 0; $i -lt 6 -and $p; $i++) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId); if ($p -and $p.Name -like "claude*") { $p.CommandLine; break } }'
  try {
    const r = await $.process.run(['powershell.exe', '-NoProfile', '-NoLogo', '-Command', script], { timeoutMs: 15000 })
    return r.stdout.trim()
  } catch {
    return ''
  }
}

// The program and the flags worth passing on; a resume, a prompt or a session id are not.
function launchFlags(commandLine) {
  const tokens = [...String(commandLine).matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2])
  const valued = new Set(['--model', '--permission-mode', '--plugin-dir', '--add-dir', '--settings', '--mcp-config', '--effort', '--agent', '--append-system-prompt-file', '--system-prompt-file', '--fallback-model'])
  const bare = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config', '--chrome', '--no-chrome', '--ide', '--verbose'])
  const flags = []
  for (let i = 1; i < tokens.length; i++) {
    const [key, value] = tokens[i].split(/=(.*)/s)
    if (bare.has(tokens[i])) flags.push(tokens[i])
    else if (valued.has(key)) {
      if (value !== undefined) flags.push(key, value)
      else if (i + 1 < tokens.length) flags.push(key, tokens[++i])
    }
  }
  return { program: tokens[0] || 'claude.exe', flags }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

async function toolHandoff($, e) {
  const prompt = String(e.prompt ?? '').trim()
  if (!prompt) return 'No prompt given.'
  const cwd = await $.session.cwd()
  const temp = (await $.env.get('TEMP')) || cwd
  const file = `${temp}\\claude-handoff-${Date.now()}.txt`
  await $.fs.write(file, prompt)
  const { program, flags } = launchFlags(await ownLaunch($))
  // Split panes take no starting folder, so PowerShell moves there first.
  const script = `Set-Location -LiteralPath ${psQuote(cwd)}; $p = Get-Content -LiteralPath ${psQuote(file)} -Raw -Encoding UTF8; Remove-Item -LiteralPath ${psQuote(file)}; & ${psQuote(program)} ${flags.map(psQuote).join(' ')} $p`
  const command = `powershell.exe -NoProfile -NoLogo -Command "${script}"`
  const tab = await findOwnTab($, true)
  const splitSelf = e.where !== 'tab' && !tab?.isAgentPane && tab?.panes.some(p => norm(p.session_id) === selfPane)
  const args = splitSelf
    ? ['split-pane', '-t', selfPane, '-d', e.direction || 'auto', ...(e.size ? ['-s', String(e.size)] : []), '-c', command]
    : ['new-tab', '-d', cwd, '-c', command]
  const r = await wt($, args)
  if (r.error) return r.error
  if (e.close_this) $.clock.after(20000, () => exitSelf($))
  return `Started a fresh session in a new ${splitSelf ? 'split' : 'tab'} in ${cwd} with ${flags.length ? flags.join(' ') : 'default flags'}.${e.close_this ? ' This session exits in 20 seconds.' : ''}`
}

async function exitSelf($) {
  try { await $.command.run({ command: 'exit' }) } catch { /* the user can close it */ }
}

async function toolResolve($, e) {
  const name = String(e.name ?? '').trim()
  if (!name) return 'No command name given.'
  const args = ['resolve-command', name, '--json']
  if (e.cwd) args.push('--cwd', e.cwd)
  if (e.shell) args.push('--shell', e.shell)
  try {
    const r = await $.process.run([await exe($, 'wta.exe'), ...args], { timeoutMs: 20000 })
    return (r.stdout || r.stderr || '').trim() || `wta exited with ${r.exitCode}`
  } catch (err) {
    return String(err?.message ?? err)
  }
}

async function runTool($, name, e) {
  if (name === 'panes') return toolPanes($)
  if (name === 'read') return toolRead($, e)
  if (name === 'run') return toolRun($, e)
  if (name === 'type') return toolType($, e)
  if (name === 'keys') return toolKeys($, e)
  if (name === 'open') return toolOpen($, e)
  if (name === 'delegate') return toolDelegate($, e)
  if (name === 'resolve_command') return toolResolve($, e)
  if (name === 'handoff') return toolHandoff($, e)
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
  const pane = { type: 'string', description: 'Pane id from panes. Leave out to use the pane the user works in.' }
  const direction = { type: 'string', enum: ['right', 'left', 'up', 'down', 'auto'] }
  const tools = [
    { name: 'panes', description: 'List Windows Terminal windows, tabs and panes with shell, folder, title, last exit code and the agent CLI running in the pane (agent, for example "claude"). Your own pane is marked "you".', inputSchema: { type: 'object', properties: {} } },
    { name: 'read', description: "Read a terminal pane's screen, or just its last command and output.", inputSchema: { type: 'object', properties: { pane, lines: { type: 'integer', description: 'How many lines, up to 400. Default 60.' }, last_command: { type: 'boolean', description: 'Only the last command and its output (needs shell integration).' } } } },
    { name: 'run', description: "Type a command into one of the user's shell panes and press Enter. The user approves it first. By default waits a few seconds and returns the output.", inputSchema: { type: 'object', properties: { command: { type: 'string', description: "The command, in that pane's shell syntax." }, pane, wait: { type: 'boolean', description: 'Wait for the result. Default true.' } }, required: ['command'] } },
    { name: 'type', description: 'Type text into the input of one or more terminal panes, then press Enter, as if the user typed it, and return what each pane shows afterwards. For example a slash command into every pane running Claude Code (find them with panes). Read a pane first: in a busy Claude Code pane text is queued, and an open dialog takes the keys. A newline in the text also presses Enter.', inputSchema: { type: 'object', properties: { panes: { type: 'array', items: { type: 'string' }, description: 'Pane ids from panes.' }, text: { type: 'string' }, enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' } }, required: ['panes', 'text'] } },
    { name: 'keys', description: 'Send key presses to a terminal pane and return what it shows afterwards. Read the pane first: Escape closes a dialog, but in a Claude Code pane that is working it stops the turn. Names: Enter, Tab, S-Tab, Escape, BSpace, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, Delete, F1 to F12, and C-<key> such as C-c. Other strings are typed as text.', inputSchema: { type: 'object', properties: { pane: { type: 'string', description: 'Pane id from panes.' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['pane', 'keys'] } },
    { name: 'open', description: 'Open a new terminal tab or split, optionally running a command, in a folder (tabs only) or with a profile.', inputSchema: { type: 'object', properties: { where: { type: 'string', enum: ['tab', 'split'] }, command: { type: 'string' }, cwd: { type: 'string', description: 'Starting folder, for tabs.' }, profile: { type: 'string', description: 'Profile name or GUID from profiles.' }, direction, size: { type: 'number', description: 'Split size from 0.1 to 0.9.' }, title: { type: 'string' }, pane: { type: 'string', description: 'Pane to split. Default: the pane the user works in.' } }, required: ['where'] } },
    { name: 'delegate', description: 'Start another Claude Code session in a new tab or split with a task. Give it everything it needs: goal, context, folder and when it is done.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, where: { type: 'string', enum: ['tab', 'split'] }, cwd: { type: 'string' }, direction, title: { type: 'string' } }, required: ['task'] } },
    { name: 'handoff', description: 'Hand this session over to a fresh Claude Code session in a split next to your own pane (or a new tab), in the same folder with the same launch flags. Write your handover first, then give the new session its first message, for example to read that handover and carry on.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: "The new session's first message." }, where: { type: 'string', enum: ['split', 'tab'], description: 'Default split.' }, direction, size: { type: 'number' }, close_this: { type: 'boolean', description: 'Exit this session 20 seconds after the new one starts. Default false.' } }, required: ['prompt'] } },
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
    sessionId = await $.session.id()
    // After a reload, start from what this session knew about its tab.
    let saved = null
    try { saved = await $.store.get(MEMORY + sessionId) } catch { saved = null }
    if (selfPane && saved?.wtPane === selfPane && saved.tabPanes?.length) {
      ownTab = { at: 0, windowId: 0, tabIndex: 0, panes: saved.tabPanes.map(id => ({ session_id: id })), isAgentPane: !!saved.isAgentPane }
    }
    await findOwnTab($, true)
    await remember($)
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

  // The intro once, then a note about the user's pane with each message they send.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const blocks = []
    if (!introSent) {
      blocks.push(INTRO)
      introSent = true
    }
    if (selfPane && (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge')) {
      const note = await terminalNote($)
      if (note) blocks.push(note)
      remember($)
    }
    if (!blocks.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && fixPending) {
      fixPending = false
      publishFixState($, { state: 'cleared' })
    }
    return r
  })

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

  // A failed command in this tab, above the prompt.
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
