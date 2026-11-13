// Every Claude Code session on this machine, for every other: each session shares its
// state (context, busy or idle, the end of its last reply), runs the slash commands
// another session asks it for, and can watch the others and compact them at good
// checkpoints. Load it in every session; it adds nothing to prompts.

const PREFIX = 'mcp__sessions__'
const NO_PROMPT_TOOLS = new Set(['list'])
const STATE = 'state:'
const CONTROL = '[sessions-control]'
const RESULT = '[sessions-result]'
const FRESH_MS = 3 * 60000

const HANDOVER = `Your context will be compacted next. Write your handover now, the way your project's rules say (if they say nothing, write a short one: the goal, what is done, what is in progress, decisions, file paths and next steps). Commit it if your project commits handovers. Then stop.`

const COMPACT = `Keep the current goal, what is done and what is left, decisions and why, open problems, and the file paths and commands that matter. Drop exploration that led nowhere.`

const CHECKPOINT = `You judge a coding agent's last message. Answer yes when it stopped at a good point to compact its context: a task or step is finished or handed off, results are reported, nothing is half done, and it is not waiting for an answer to a question it asked. Otherwise answer no. Reply with one word: yes or no.`

const WATCH_DEFAULTS = { enabled: true, mode: 'ask', min_context_k: 400, min_idle_minutes: 3, handover: true, handover_prompt: '', instructions: '', checkpoint_check: true }

let sessionId = ''
let home = ''
let status = 'idle'
let statusSince = 0
let lastReply = ''
let pending = null // { command, args, from } to run after a requested handover turn
let watchCfg = null
let watchTimer = null
let watching = false
let proposals = []
const acted = new Map()
const checked = new Map()

function clip(text, max) {
  const s = String(text ?? '').trimEnd()
  return s.length > max ? '...' + s.slice(s.length - max) : s
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

// "/compact keep the plan" -> { command: 'compact', args: 'keep the plan' }
function splitCommand(line) {
  const m = String(line ?? '').trim().match(/^\/?(\S+)\s*([\s\S]*)$/)
  return m ? { command: m[1], args: m[2] } : null
}

async function findHome($) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const user = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return user ? `${user}/.claude` : ''
}

async function publishSelf($) {
  try {
    sessionId = await $.session.id()
    let c = null
    try { c = (await $.session.usage()).context } catch { c = null }
    await $.store.set(STATE + sessionId, {
      k: c && typeof c.tokens === 'number' ? Math.round(c.tokens / 1000) : null,
      w: c && c.window ? Math.round(c.window / 1000) : null,
      status,
      since: statusSince,
      reply: lastReply,
      cwd: await $.session.cwd(),
      at: await $.clock.now(),
    })
  } catch {
    // The store is for other sessions; this one works without it.
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
    try { rec = await $.store.get(STATE + reg.sessionId) } catch { rec = null }
    const statusAt = reg.statusUpdatedAt || rec?.since || 0
    rows.push({
      id: reg.sessionId,
      name: reg.name || reg.sessionId.slice(0, 8),
      status: reg.status || rec?.status || '',
      idleMin: reg.status === 'idle' && statusAt ? Math.round((now - statusAt) / 60000) : 0,
      cwd: reg.cwd || rec?.cwd || '',
      rec: rec && now - rec.at < FRESH_MS ? rec : null,
    })
  }
  rows.sort((a, b) => (b.rec?.k ?? -1) - (a.rec?.k ?? -1))
  return rows
}

function sessionLine(s) {
  const ctx = s.rec?.k != null ? `${s.rec.k}k of ${s.rec.w}k` : 'context unknown (no sessions mod there)'
  const state = s.status === 'idle' ? `idle ${s.idleMin} min` : s.status
  const last = s.rec?.reply ? `\n    last: ${clip(s.rec.reply.replace(/\s+/g, ' '), 200)}` : ''
  return `${s.name}${s.id === sessionId ? ' (you)' : ''} [${s.id}]: ${state}, ${ctx}, ${s.cwd}${last}`
}

async function findSession($, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const all = await liveSessions($)
  return all.find(s => s.id.toLowerCase() === q) ?? all.find(s => s.name.toLowerCase() === q) ?? all.find(s => s.id.toLowerCase().startsWith(q)) ?? null
}

// Asks another session to run a slash command, after a handover turn when asked.
async function askToRun($, s, opts) {
  if (!s.rec) return `${s.name} doesn't run the sessions mod, so it can't be asked. Type the command into its pane instead.`
  const token = await controlToken($, true)
  const msg = { op: 'command', token, from: sessionId, line: opts.line, handover: !!opts.handover, handoverPrompt: opts.handover_prompt || '' }
  const sent = await $.session.send({ to: { sessionId: s.id }, text: pack(CONTROL, msg) })
  if (!sent.isDelivered) return `Couldn't reach ${s.name}: ${sent.reason}`
  return `Asked ${s.name} to ${msg.handover ? 'write its handover, then ' : ''}run ${opts.line}.`
}

async function askToCompact($, s, opts) {
  const reply = await askToRun($, s, {
    line: `/compact ${opts.instructions || COMPACT}`,
    handover: opts.handover !== false,
    handover_prompt: opts.handover_prompt,
  })
  if (reply.startsWith('Asked')) acted.set(s.id, s.rec?.k ?? 0)
  return reply
}

// Runs in the session that was asked.
async function handleControl($, msg) {
  if (msg.op !== 'command') return
  const cmd = splitCommand(msg.line)
  if (!cmd) return
  if (msg.handover) {
    pending = { ...cmd, from: msg.from }
    const r = await $.prompt.submit({ text: msg.handoverPrompt || HANDOVER })
    if (r?.drop) {
      pending = null
      report($, msg.from, `didn't start its handover: ${r.drop}`)
    }
    return
  }
  await runCommand($, cmd, msg.from)
}

async function runCommand($, cmd, from) {
  try {
    await $.command.run({ command: cmd.command, args: cmd.args })
    report($, from, `ran /${cmd.command}`)
  } catch (err) {
    report($, from, `couldn't run /${cmd.command}: ${String(err?.message ?? err)}`)
  }
}

async function report($, to, text) {
  if (!to) return
  try {
    const token = await controlToken($, false)
    await $.session.send({ to: { sessionId: to }, text: pack(RESULT, { token, from: sessionId, text }) })
  } catch {
    // The sender can still see the change in the session list.
  }
}

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
        $.ui.log(`sessions: ${await askToCompact($, s, watchCfg)} (${s.rec.k}k, idle ${s.idleMin} min)`)
      } else {
        acted.set(s.id, s.rec.k ?? 0)
        proposals.push({ id: s.id, name: s.name, k: s.rec.k })
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
  if (s) $.ui.log(`sessions: ${await askToCompact($, s, watchCfg ?? {})}`)
}

function watchSummary() {
  if (!watchCfg?.enabled) return 'The session watcher is off.'
  const c = watchCfg
  return `Watching every session: at ${c.min_context_k}k context or more, idle ${c.min_idle_minutes} min or more${c.checkpoint_check ? ', at a good checkpoint' : ''}, I ${c.mode === 'auto' ? 'ask it' : 'offer'} to ${c.handover ? 'write its handover and ' : ''}run /compact.`
}

async function toolWatch($, e) {
  const next = { ...WATCH_DEFAULTS, ...(watchCfg ?? {}) }
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
  if (name === 'list') {
    const rows = await liveSessions($)
    return rows.length ? rows.map(sessionLine).join('\n') : 'No sessions found.'
  }
  const s = name === 'watch' ? null : await findSession($, e.session)
  if (name !== 'watch' && !s) return `No live session called ${e.session}.`
  if (s && s.id === sessionId) return "That's you."
  if (name === 'command') {
    const line = String(e.command ?? '').trim()
    if (!line) return 'No command given.'
    return askToRun($, s, { line: line.startsWith('/') ? line : `/${line}`, handover: e.handover, handover_prompt: e.handover_prompt })
  }
  if (name === 'compact') return askToCompact($, s, e)
  if (name === 'watch') return toolWatch($, e)
  return `Unknown tool ${name}.`
}

async function registerTools($) {
  const session = { type: 'string', description: 'Name or id from list.' }
  const tools = [
    { name: 'list', description: 'List every live Claude Code session on this machine: name, id, busy or idle and for how long, context size, folder, and the end of its last reply.', inputSchema: { type: 'object', properties: {} } },
    { name: 'command', description: 'Ask another session to run a slash command itself, exactly as if typed there, for example "/compact" or "/model sonnet". Works for sessions that load the sessions mod.', inputSchema: { type: 'object', properties: { session, command: { type: 'string' }, handover: { type: 'boolean', description: 'Write a handover first. Default false.' }, handover_prompt: { type: 'string' } }, required: ['session', 'command'] } },
    { name: 'compact', description: 'Ask another session to write its handover and then run /compact.', inputSchema: { type: 'object', properties: { session, handover: { type: 'boolean', description: 'Default true.' }, handover_prompt: { type: 'string' }, instructions: { type: 'string', description: 'What /compact should keep.' } }, required: ['session'] } },
    { name: 'watch', description: 'Keep an eye on every session in the background without using your turns. When one is idle, past a context size and stopped at a good checkpoint, ask it (mode auto) or offer the user (mode ask) to write its handover and /compact. Call with only the fields to change.', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, mode: { type: 'string', enum: ['ask', 'auto'] }, min_context_k: { type: 'number', description: 'Default 400.' }, min_idle_minutes: { type: 'number', description: 'Default 3.' }, handover: { type: 'boolean', description: 'Default true.' }, handover_prompt: { type: 'string' }, instructions: { type: 'string' }, checkpoint_check: { type: 'boolean', description: 'Default true.' } } } },
  ]
  for (const tool of tools) {
    try { await $.tool.register({ ...tool, isDeferred: true }) } catch { /* already registered */ }
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = await findHome($)
    statusSince = await $.clock.now()
    await publishSelf($)
    $.clock.every(60000, () => publishSelf($))
    await registerTools($)
    try { await $.command.register({ name: 'sessions', description: 'Show every Claude Code session', immediate: true }) } catch { /* taken */ }
    try { await $.command.register({ name: 'watch', description: 'Show or turn the session watcher on or off', argumentHint: '[on|off]', immediate: true }) } catch { /* taken */ }
    try { watchCfg = await $.store.get('watch:config') } catch { watchCfg = null }
    if (watchCfg?.enabled) {
      const owner = await $.store.get('watch:owner')
      if (owner?.id === sessionId) startWatcher($)
    }
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
    if (pending) {
      const cmd = pending
      pending = null
      // Outside this hook, so the command can queue.
      $.clock.after(0, () => runCommand($, cmd, cmd.from))
    }
    return r
  })

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
      return { consumed: 'sessions control message' }
    }
    const s = (await liveSessions($)).find(x => x.id === result.from)
    $.ui.log(`sessions: ${s?.name ?? result.from} ${result.text}`)
    return { consumed: 'sessions result' }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool ?? '')
    if (!name.startsWith(PREFIX)) return next(e)
    return { result: await runTool($, name.slice(PREFIX.length), e) }
  }).catch(($, e, next) => ({ result: `The sessions tool failed: ${next.error?.message ?? 'unknown error'}` }))

  on('tool.check', async ($, e, next) => {
    const name = String(e.tool ?? '')
    if (!name.startsWith(PREFIX) || !NO_PROMPT_TOOLS.has(name.slice(PREFIX.length))) return next(e)
    const decision = await next(e)
    return decision.decision === 'ask' ? { decision: 'allow', reason: 'Read-only sessions tool' } : decision
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sessions' }, async ($) => {
    for (const s of await liveSessions($)) $.ui.log(sessionLine(s))
    return {}
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') await toolWatch($, { enabled: arg === 'on' })
    $.ui.log(watchSummary())
    return {}
  })

  // Sessions the watcher offers to compact, above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!proposals.length) return next(e)
    const ui = $.ui.resolve(e)
    const p = proposals[0]
    const more = proposals.length > 1 ? ` (+${proposals.length - 1} more)` : ''
    const row = ui.Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        ui.Text({ wrap: 'truncate', children: [`${p.name} is idle at a checkpoint with ${p.k}k context${more}`] }),
        ui.Button({ key: 'sessions-compact', label: 'Hand over + compact', hotkey: '4', plain: true, onPress: () => acceptProposal($, p, true) }),
        ui.Button({ key: 'sessions-skip', label: 'Skip', hotkey: '5', plain: true, onPress: () => acceptProposal($, p, false) }),
      ],
    })
    const rest = await next(e)
    return rest ? ui.Box({ flexDirection: 'column', children: [row, rest] }) : row
  })
}
