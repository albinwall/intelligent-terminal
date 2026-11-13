// Intelligent Terminal features for Claude Code: tools for panes and sessions, a note about
// the user's pane with each prompt, and a Fix line when a command fails in the same tab.
// The terminal is reached through wtcli.exe, which ships with Intelligent Terminal.

const WTCLI = 'wtcli.exe'
const PREFIX = 'mcp__terminal__'
const NO_PROMPT_TOOLS = new Set(['panes', 'read', 'profiles', 'resolve_command', 'focus', 'sessions'])
const FLEET = 'fleet:'
const CONTROL = '[terminal-control]'
const RESULT = '[terminal-result]'
const FRESH_MS = 3 * 60000

const INTRO = `You are running inside Intelligent Terminal (Windows Terminal with agent support). The mcp__terminal__ tools let you see and use the terminal and the other Claude Code sessions:
- panes lists windows, tabs and panes, with the agent CLI running in each. read reads a pane's screen, or just its last command and output.
- run types a command into one of the user's shell panes and can wait for the result. type types text into one or more panes and presses Enter, for example a slash command into every pane running Claude Code. keys sends key presses such as Escape, Enter or C-c.
- open opens a new tab or split, with an optional command, folder or profile. delegate starts another Claude in a new tab or split with a task.
- profiles lists terminal profiles. resolve_command shows what a command name resolves to for a folder and shell. focus and close act on a pane.
- sessions lists every Claude Code session on this machine with busy or idle, idle time and context size. compact_session asks one to write its handover and run /compact. watch keeps an eye on all sessions and does that at good checkpoints. To talk to a session, use SendMessage.
Each user message comes with a short "Terminal" note about the pane the user is working in. Use that pane's shell syntax and folder for commands meant for it. Your own Bash or PowerShell tool runs in a separate process and doesn't change that pane. Use run when the user wants something done in their pane; for questions, just answer.`

const FIX = `My last command failed. Work out what I was trying to do and why it failed, fix whatever needs fixing, then give me the corrected command with the terminal run tool so I can approve it. If it's an obvious typo, go straight to the corrected command. If you can't tell what I want, ask me. Your own shell is separate from that pane, so changes you make there don't affect it.`

const EXPLAIN = `Explain why my last command failed. Don't run or change anything.`

const HANDOVER = `Your context will be compacted next. Write your handover now, the way your project's rules say (if they say nothing, write a short one: the goal, what is done, what is in progress, decisions, file paths and next steps). Commit it if your project commits handovers. Then stop.`

const COMPACT = `Keep the current goal, what is done and what is left, decisions and why, open problems, and the file paths and commands that matter. Drop exploration that led nowhere.`

const CHECKPOINT = `You judge a coding agent's last message. Answer yes when it stopped at a good point to compact its context: a task or step is finished or handed off, results are reported, nothing is half done, and it is not waiting for an answer to a question it asked. Otherwise answer no. Reply with one word: yes or no.`

const WATCH_DEFAULTS = { enabled: true, mode: 'ask', min_context_k: 400, min_idle_minutes: 3, handover: true, handover_prompt: '', instructions: '', checkpoint_check: true }

let sessionId = ''
let selfPane = ''
let home = ''
let lastWtError = ''
const exePaths = new Map()
let ownTab = null // { at, windowId, tabIndex, panes, isAgentPane }
let tabStableId = ''
let lastShellPane = ''
let failure = null // { pane, rawPane, code, summary, output, shell, cwd, dismissed }
let fixPending = false
let introSent = false
let listening = false
let status = 'idle'
let statusSince = 0
let lastReply = ''
let handover = null // { instructions, from } while a requested handover turn runs
let watchCfg = null
let watchTimer = null
let watching = false
let proposals = [] // sessions the watcher wants to compact, in ask mode
const lastExit = new Map()
const doneCount = new Map()
const acted = new Map() // session id -> context (k) when it was asked to compact
const checked = new Map() // session id -> { reply, ok }

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

function randomToken() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function pack(marker, obj) {
  return `${marker} ${encodeURIComponent(JSON.stringify(obj))}`
}

function unpack(marker, text) {
  const m = String(text ?? '').match(new RegExp(marker.replace(/[[\]]/g, '\\$&') + ' (\\S+)'))
  if (!m) return null
  try { return JSON.parse(decodeURIComponent(m[1])) } catch { return null }
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
      if (r.exitCode !== 0) {
        lastWtError = `${candidate} --help: exit ${r.exitCode} ${(r.stderr || r.stdout).trim().slice(0, 200)}`
        continue
      }
      exePaths.set(name, candidate)
      return candidate
    } catch (err) {
      lastWtError = `${candidate}: ${String(err?.message ?? err).slice(0, 200)}`
    }
  }
  exePaths.set(name, name)
  return name
}

async function wt($, args, stdin) {
  try {
    const r = await $.process.run([await exe($, WTCLI), '--json', ...args], stdin ? { stdin, timeoutMs: 10000 } : { timeoutMs: 10000 })
    if (r.exitCode !== 0) {
      lastWtError = `${args[0]} (${exePaths.get(WTCLI)}): ${(r.stderr || r.stdout || 'wtcli failed').trim()}`
      return { error: lastWtError }
    }
    lastWtError = ''
    try { return JSON.parse(r.stdout) } catch { return { text: r.stdout } }
  } catch (err) {
    lastWtError = `${args[0]}: ${String(err?.message ?? err)}`
    return { error: lastWtError }
  }
}

// ---------- the terminal ----------

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

async function screenTail($, pane, lines) {
  const r = await wt($, ['capture-pane', '-t', pane, '-l', String(lines)])
  return r.error ? '' : String(r.content ?? '').split(/\r?\n/).filter(l => l.trim()).join('\n')
}

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
  if (!cap.has_marks) {
    const tail = await wt($, ['capture-pane', '-t', pane, '-l', '40'])
    output = tail.content ?? ''
  }
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

// ---------- the sessions ----------

async function findHome($) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const user = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return user ? `${user}/.claude` : ''
}

// This session's state, for the sessions tool in other sessions.
async function publishSelf($) {
  try {
    sessionId = await $.session.id()
    let c = null
    try { c = (await $.session.usage()).context } catch { c = null }
    await $.store.set(FLEET + sessionId, {
      k: c && typeof c.tokens === 'number' ? Math.round(c.tokens / 1000) : null,
      w: c && c.window ? Math.round(c.window / 1000) : null,
      status,
      since: statusSince,
      reply: lastReply,
      cwd: await $.session.cwd(),
      wtPane: selfPane,
      tabPanes: (ownTab?.panes ?? []).map(p => norm(p.session_id)),
      isAgentPane: !!ownTab?.isAgentPane,
      wtError: lastWtError,
      at: await $.clock.now(),
    })
  } catch {
    // The store is for other sessions; this session works without it.
  }
}

async function controlToken($, create) {
  let token = null
  try { token = await $.store.get('control:token') } catch { token = null }
  if (!token && create) {
    token = randomToken()
    try { await $.store.set('control:token', token) } catch { /* the next send tries again */ }
  }
  return token
}

// Every live session (Claude Code's own register), with what it shared.
async function liveSessions($) {
  if (!home) return []
  let entries = []
  try { entries = await $.fs.list(`${home}/sessions`) } catch { return [] }
  const now = await $.clock.now()
  const rows = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    let reg
    try { reg = JSON.parse(await $.fs.read(`${home}/sessions/${f.name}`)) } catch { continue }
    if (!reg || typeof reg.sessionId !== 'string') continue
    let rec = null
    try { rec = await $.store.get(FLEET + reg.sessionId) } catch { rec = null }
    const fresh = !!rec && now - rec.at < FRESH_MS
    const statusAt = reg.statusUpdatedAt || rec?.since || 0
    rows.push({
      id: reg.sessionId,
      name: reg.name || reg.sessionId.slice(0, 8),
      status: reg.status || rec?.status || '',
      idleMin: reg.status === 'idle' && statusAt ? Math.round((now - statusAt) / 60000) : 0,
      cwd: reg.cwd || rec?.cwd || '',
      kind: reg.kind || '',
      rec: fresh ? rec : null,
    })
  }
  rows.sort((a, b) => (b.rec?.k ?? -1) - (a.rec?.k ?? -1))
  return rows
}

function sessionLine(s, me) {
  const ctx = s.rec?.k != null ? `${s.rec.k}k of ${s.rec.w}k` : 'context unknown'
  const state = s.status === 'idle' ? `idle ${s.idleMin} min` : s.status
  const where = s.rec?.wtPane ? `terminal pane ${s.rec.wtPane}` : ''
  const mod = s.rec ? '' : ', no terminal mod'
  const last = s.rec?.reply ? `\n    last: ${clip(s.rec.reply.replace(/\s+/g, ' '), 200)}` : ''
  return `${s.name}${s.id === me ? ' (you)' : ''} [${s.id}]: ${state}, ${ctx}, ${s.cwd}${where ? ', ' + where : ''}${mod}${last}`
}

async function findSession($, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const all = await liveSessions($)
  return all.find(s => s.id.toLowerCase() === q) ?? all.find(s => s.name.toLowerCase() === q) ?? all.find(s => s.id.toLowerCase().startsWith(q)) ?? null
}

async function askToCompact($, s, opts) {
  if (!s.rec) return `${s.name} doesn't run the terminal mod, so it can't be asked. Type /compact into its pane instead with the type tool.`
  const token = await controlToken($, true)
  const msg = { op: 'compact', token, from: sessionId, handover: opts.handover !== false, handoverPrompt: opts.handover_prompt || '', instructions: opts.instructions || COMPACT }
  const sent = await $.session.send({ to: { sessionId: s.id }, text: pack(CONTROL, msg) })
  if (!sent.isDelivered) return `Couldn't reach ${s.name}: ${sent.reason}`
  acted.set(s.id, s.rec.k ?? 0)
  return `Asked ${s.name} to ${msg.handover ? 'write its handover, then ' : ''}run /compact.`
}

// Runs in the session that was asked: the handover turn, then /compact.
async function handleControl($, msg) {
  if (msg.op !== 'compact') return
  const instructions = String(msg.instructions ?? '')
  if (msg.handover) {
    handover = { instructions, from: msg.from }
    const r = await $.prompt.submit({ text: msg.handoverPrompt || HANDOVER })
    if (r?.drop) {
      handover = null
      report($, msg.from, `didn't start its handover: ${r.drop}`)
    }
    return
  }
  await runCompact($, instructions, msg.from)
}

async function runCompact($, instructions, from) {
  try {
    await $.command.run({ command: 'compact', args: instructions })
    report($, from, 'wrote its handover and compacted')
  } catch (err) {
    report($, from, `couldn't compact: ${String(err?.message ?? err)}`)
  }
}

async function report($, to, text) {
  if (!to) return
  try {
    const token = await controlToken($, false)
    await $.session.send({ to: { sessionId: to }, text: pack(RESULT, { token, from: sessionId, text }) })
  } catch {
    // The sender sees the drop in context anyway.
  }
}

// ---------- the watcher ----------

async function atCheckpoint($, s) {
  const reply = s.rec?.reply ?? ''
  if (!reply) return false
  const known = checked.get(s.id)
  if (known && known.reply === reply) return known.ok
  let ok = false
  try {
    const r = await $.model.complete({ model: 'haiku', system: CHECKPOINT, prompt: reply, maxTokens: 5, timeoutMs: 20000 })
    ok = r.isAnswered && /^\s*yes/i.test(r.text)
  } catch {
    ok = false
  }
  checked.set(s.id, { reply, ok })
  return ok
}

async function watchTick($) {
  if (!watchCfg?.enabled || watching) return
  watching = true
  try {
    const now = await $.clock.now()
    const owner = await $.store.get('watch:owner')
    if (owner && owner.id !== sessionId && now - owner.at < 2 * 60000) return
    await $.store.set('watch:owner', { id: sessionId, at: now })
    for (const s of await liveSessions($)) {
      if (s.id === sessionId || !s.rec || s.status !== 'idle') continue
      if (s.idleMin < watchCfg.min_idle_minutes || (s.rec.k ?? 0) < watchCfg.min_context_k) continue
      const before = acted.get(s.id)
      if (before !== undefined && s.rec.k > before - 50) continue
      if (proposals.some(p => p.id === s.id)) continue
      if (watchCfg.checkpoint_check && !(await atCheckpoint($, s))) continue
      if (watchCfg.mode === 'auto') {
        $.ui.log(`terminal: ${await askToCompact($, s, watchCfg)} (${s.rec.k}k, idle ${s.idleMin} min)`)
      } else {
        acted.set(s.id, s.rec.k ?? 0)
        proposals.push({ id: s.id, name: s.name, k: s.rec.k, idleMin: s.idleMin })
        $.ui.invalidate('ui.render')
      }
    }
  } catch {
    // Try again next round.
  } finally {
    watching = false
  }
}

function startWatcher($) {
  if (watchTimer) watchTimer.cancel()
  watchTimer = watchCfg?.enabled ? $.clock.every(30000, () => watchTick($)) : null
}

async function acceptProposal($, p, yes) {
  proposals = proposals.filter(x => x.id !== p.id)
  $.ui.invalidate('ui.render')
  if (!yes) return
  const s = await findSession($, p.id)
  if (s) $.ui.log(`terminal: ${await askToCompact($, s, watchCfg ?? {})}`)
}

function watchSummary() {
  if (!watchCfg?.enabled) return 'The session watcher is off.'
  const c = watchCfg
  return `Watching every session: at ${c.min_context_k}k context or more, idle ${c.min_idle_minutes} min or more${c.checkpoint_check ? ', at a good checkpoint' : ''}, I ${c.mode === 'auto' ? 'ask it' : 'offer'} to ${c.handover ? 'write its handover and ' : ''}run /compact.`
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
  if ((doneCount.get(pane) ?? 0) === before) return `Sent to pane ${pane}. It's still running, or the pane has no shell integration. Use read to check on it.`
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
  const r = await wt($, ['send-keys', '-t', pane, '--', ...keys])
  if (r.error) return r.error
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

async function toolSessions($) {
  const rows = await liveSessions($)
  if (!rows.length) return 'No sessions found.'
  return rows.map(s => sessionLine(s, sessionId)).join('\n')
}

async function toolCompact($, e) {
  const s = await findSession($, e.session)
  if (!s) return `No live session called ${e.session}.`
  if (s.id === sessionId) return "That's you. Run /compact yourself."
  return askToCompact($, s, e)
}

async function toolWatch($, e) {
  const base = watchCfg ?? WATCH_DEFAULTS
  const next = { ...WATCH_DEFAULTS, ...base }
  for (const key of Object.keys(WATCH_DEFAULTS)) {
    if (e[key] !== undefined) next[key] = e[key]
  }
  watchCfg = next
  try { await $.store.set('watch:config', next) } catch { /* kept for this session */ }
  if (next.enabled) {
    try { await $.store.set('watch:owner', { id: sessionId, at: await $.clock.now() }) } catch { /* next round */ }
  }
  startWatcher($)
  return watchSummary()
}

async function runTool($, name, e) {
  if (name === 'panes') return toolPanes($)
  if (name === 'read') return toolRead($, e)
  if (name === 'run') return toolRun($, e)
  if (name === 'keys') return toolKeys($, e)
  if (name === 'type') return toolType($, e)
  if (name === 'open') return toolOpen($, e)
  if (name === 'delegate') return toolDelegate($, e)
  if (name === 'resolve_command') return toolResolve($, e)
  if (name === 'sessions') return toolSessions($)
  if (name === 'compact_session') return toolCompact($, e)
  if (name === 'watch') return toolWatch($, e)
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
  const direction = { type: 'string', enum: ['right', 'left', 'up', 'down', 'auto'] }
  const tools = [
    { name: 'panes', description: 'List Windows Terminal windows, tabs and panes with shell, folder, title, last exit code and the agent CLI running in the pane (agent, for example "claude"). Your own pane is marked "you".', inputSchema: { type: 'object', properties: {} } },
    { name: 'type', description: 'Type text into the input of one or more terminal panes, then press Enter, as if the user typed it, and returns what each pane shows afterwards. For example a slash command into every pane running Claude Code (find them with panes). Read a pane first to see what it shows now: in a Claude Code pane that is busy, text is queued, and an open dialog takes the keys. A newline in the text also presses Enter.', inputSchema: { type: 'object', properties: { panes: { type: 'array', items: { type: 'string' }, description: 'Pane ids from panes.' }, text: { type: 'string' }, enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' } }, required: ['panes', 'text'] } },
    { name: 'read', description: "Read a terminal pane's screen, or just its last command and output.", inputSchema: { type: 'object', properties: { pane, lines: { type: 'integer', description: 'How many lines, up to 400. Default 60.' }, last_command: { type: 'boolean', description: 'Only the last command and its output (needs shell integration).' } } } },
    { name: 'run', description: "Type a command into one of the user's terminal panes and press Enter. The user approves it first. By default waits a few seconds and returns the output.", inputSchema: { type: 'object', properties: { command: { type: 'string', description: "The command, in that pane's shell syntax." }, pane, wait: { type: 'boolean', description: 'Wait for the result. Default true.' } }, required: ['command'] } },
    { name: 'keys', description: 'Send key presses to a terminal pane and return what it shows afterwards. Read the pane first: Escape closes a dialog, but in a Claude Code pane that is working it stops the turn. Names: Enter, Tab, Escape, BSpace, C-c and other C-<key>. Other strings are typed as text.', inputSchema: { type: 'object', properties: { pane: { type: 'string', description: 'Pane id from panes.' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['pane', 'keys'] } },
    { name: 'open', description: 'Open a new terminal tab or split, optionally running a command, in a folder (tabs only) or with a profile.', inputSchema: { type: 'object', properties: { where: { type: 'string', enum: ['tab', 'split'] }, command: { type: 'string' }, cwd: { type: 'string', description: 'Starting folder, for tabs.' }, profile: { type: 'string', description: 'Profile name or GUID from profiles.' }, direction, size: { type: 'number', description: 'Split size from 0.1 to 0.9.' }, title: { type: 'string' }, pane: { type: 'string', description: 'Pane to split. Default: the pane the user is working in.' } }, required: ['where'] } },
    { name: 'delegate', description: 'Start another Claude Code session in a new tab or split with a task. Give it everything it needs: goal, context, folder and when it is done.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, where: { type: 'string', enum: ['tab', 'split'] }, cwd: { type: 'string' }, direction, title: { type: 'string' } }, required: ['task'] } },
    { name: 'profiles', description: 'List the terminal profiles (id, name, default, agent).', inputSchema: { type: 'object', properties: {} } },
    { name: 'resolve_command', description: 'Find what a command name resolves to for a folder and shell, with close matches when it is not found.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, cwd: { type: 'string' }, shell: { type: 'string', description: 'For example pwsh.exe, powershell.exe, cmd.exe, bash.' } }, required: ['name'] } },
    { name: 'focus', description: 'Move focus to a terminal pane.', inputSchema: { type: 'object', properties: { pane }, required: ['pane'] } },
    { name: 'close', description: 'Close a terminal pane.', inputSchema: { type: 'object', properties: { pane }, required: ['pane'] } },
    { name: 'sessions', description: 'List every live Claude Code session on this machine: name, id, busy or idle and for how long, context size, folder, where it runs, and the end of its last reply.', inputSchema: { type: 'object', properties: {} } },
    { name: 'compact_session', description: 'Ask another session to write its handover and then run /compact. It runs them itself, as if typed.', inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'Name or id from sessions.' }, handover: { type: 'boolean', description: 'Write a handover first. Default true.' }, handover_prompt: { type: 'string', description: 'What to ask for in the handover, if not the default.' }, instructions: { type: 'string', description: 'What /compact should keep, if not the default.' } }, required: ['session'] } },
    { name: 'watch', description: 'Keep an eye on every session in the background, without using your turns. When one is idle, past a context size, and stopped at a good checkpoint, ask it (mode auto) or offer the user (mode ask) to write its handover and /compact. Call with only the fields to change.', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, mode: { type: 'string', enum: ['ask', 'auto'] }, min_context_k: { type: 'number', description: 'Context size in thousands of tokens. Default 400.' }, min_idle_minutes: { type: 'number', description: 'Default 3.' }, handover: { type: 'boolean', description: 'Handover before /compact. Default true.' }, handover_prompt: { type: 'string' }, instructions: { type: 'string', description: 'What /compact should keep.' }, checkpoint_check: { type: 'boolean', description: 'Only at a good checkpoint, judged from the last reply. Default true.' } } } },
  ]
  for (const tool of tools) {
    try { await $.tool.register({ ...tool, isDeferred: false }) } catch { /* already registered */ }
  }
}

// ---------- hooks ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = await findHome($)
    selfPane = norm(await $.env.get('WT_SESSION'))
    // After a reload, start from what this session knew about its tab.
    sessionId = await $.session.id()
    let saved = null
    try { saved = await $.store.get(FLEET + sessionId) } catch { saved = null }
    if (selfPane && saved?.wtPane === selfPane && saved.tabPanes?.length) {
      ownTab = { at: 0, windowId: 0, tabIndex: 0, panes: saved.tabPanes.map(id => ({ session_id: id })), isAgentPane: !!saved.isAgentPane }
    }
    await findOwnTab($, true)
    statusSince = await $.clock.now()
    await publishSelf($)
    $.clock.every(60000, () => publishSelf($))

    await registerTools($)
    try { await $.command.register({ name: 'fix', description: 'Fix the last failed command in this tab', argumentHint: '[note]' }) } catch { /* taken */ }
    try { await $.command.register({ name: 'panes', description: 'Show the terminal panes', immediate: true }) } catch { /* taken */ }
    try { await $.command.register({ name: 'sessions', description: 'Show every Claude Code session', immediate: true }) } catch { /* taken */ }
    try { await $.command.register({ name: 'watch', description: 'Show or turn off the session watcher', argumentHint: '[off|on]', immediate: true }) } catch { /* taken */ }
    await controlToken($, true)
    try { watchCfg = await $.store.get('watch:config') } catch { watchCfg = null }
    startWatcher($)
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

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      status = 'working'
      statusSince = await $.clock.now()
      publishSelf($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    status = 'idle'
    statusSince = await $.clock.now()
    if (typeof e.text === 'string' && e.text) lastReply = clip(e.text, 800)
    publishSelf($)
    if (fixPending) {
      fixPending = false
      publishFixState($, { state: 'cleared' })
    }
    if (handover) {
      const h = handover
      handover = null
      // Outside this hook, so /compact can queue.
      $.clock.after(0, () => runCompact($, h.instructions, h.from))
    }
    return r
  })

  // Control messages from another session running this mod, and their results.
  on('session.receive', async ($, e, next) => {
    if (e.agentId || e.origin?.kind !== 'peer-send-message') return next(e)
    const control = unpack(CONTROL, e.text)
    const result = control ? null : unpack(RESULT, e.text)
    const msg = control ?? result
    if (!msg) return next(e)
    const token = await controlToken($, false)
    if (!token || msg.token !== token) return next(e)
    if (control) {
      $.clock.after(0, () => handleControl($, control))
      return { consumed: 'terminal control message' }
    }
    const s = (await liveSessions($)).find(x => x.id === result.from)
    $.ui.log(`terminal: ${s?.name ?? result.from} ${result.text}`)
    return { consumed: 'terminal result' }
  }).catch(($, e, next) => next(e))

  // Add the terminal note to each message the user sends.
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

  on('command.run', { command: 'sessions' }, async ($) => {
    for (const line of (await toolSessions($)).split('\n')) $.ui.log(line)
    return {}
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') await toolWatch($, { enabled: arg === 'on' })
    $.ui.log(watchSummary())
    return {}
  })

  // Above the prompt: a failed command, and sessions the watcher wants to compact.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const showFailure = failure && !failure.dismissed
    if (!showFailure && !proposals.length) return next(e)
    const ui = $.ui.resolve(e)
    const rows = []
    if (showFailure) {
      const f = failure
      rows.push(ui.Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          ui.Text({ color: 'red', wrap: 'truncate', children: ['✗ ' + f.summary] }),
          ui.Button({ key: 'terminal-fix', label: 'Fix', hotkey: '1', plain: true, onPress: () => startFix($, f, 'fix', '') }),
          ui.Button({ key: 'terminal-explain', label: 'Explain', hotkey: '2', plain: true, onPress: () => startFix($, f, 'explain', '') }),
          ui.Button({ key: 'terminal-dismiss', label: 'Dismiss', hotkey: '3', plain: true, onPress: () => dismissFailure($) }),
        ],
      }))
    }
    if (proposals.length) {
      const p = proposals[0]
      const more = proposals.length > 1 ? ` (+${proposals.length - 1} more)` : ''
      rows.push(ui.Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          ui.Text({ wrap: 'truncate', children: [`${p.name} is idle at a checkpoint with ${p.k}k context${more}`] }),
          ui.Button({ key: 'terminal-compact', label: 'Hand over + compact', hotkey: '4', plain: true, onPress: () => acceptProposal($, p, true) }),
          ui.Button({ key: 'terminal-skip', label: 'Skip', hotkey: '5', plain: true, onPress: () => acceptProposal($, p, false) }),
        ],
      }))
    }
    const rest = await next(e)
    if (rest) rows.push(rest)
    return rows.length === 1 ? rows[0] : ui.Box({ flexDirection: 'column', children: rows })
  })
}
