import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConflictView, Hub, SessionView } from '../types'
import {
  base64Bytes,
  cleanTitle,
  findConflicts,
  forecast,
  formatAge,
  formatTokens,
  ingestChunk,
  isInside,
  needsEnglish,
  newTracker,
  projectOf,
  projectFolderName,
  verdictLabel,
} from './parse'
import type { Tracker } from './parse'
import { isFresh, parseBeacon, pickAnnouncer, scheduleLine } from './beacon'
import type { Beacon, BeaconCron, BeaconTask } from './beacon'

const PANE = 'agent-task-hub'
const TITLE = 'Agent Task Hub'

const TICK_MS = 5_000
const LIMIT_REFRESH_MS = 60_000
/** Busy with no transcript change for this long counts as possibly stuck. */
const QUIET_MS = 10 * 60_000
/** Edits older than this do not count toward a conflict. */
const CONFLICT_MS = 2 * 60 * 60_000
/** A transcript bigger than this is read from its tail on first sight. */
const FIRST_READ_MAX = 24 * 1024 * 1024
/** Most bytes read from one transcript per tick, so a tick stays short. */
const TICK_BYTES = 8 * 1024 * 1024
const CHUNK = 3 * 1024 * 1024
/** Share of the compaction limit at which this session is told to wrap up. */
const NOTE_AT = 0.85
/** Chats idle for longer than this fold into one line at the bottom. */
const EARLIER_MS = 60 * 60_000

const EMPTY: Hub = { project: '', updatedAt: 0, sessions: [], conflicts: [] }
// Change the shape tag when Hub's fields change: it declines older values.
const hub = atom({ plugin: 'agent-task-hub', key: 'hub' } as const, EMPTY, { shape: 'hub-5' })
/** Whether chats idle for over an hour are unfolded. */
const showEarlier = atom({ plugin: 'agent-task-hub', key: 'showEarlier' } as const, false)

type Entry = { t: Tracker; path: string; size: number; lastGrowMs: number }
type LiveSession = {
  sessionId: string
  cwd: string
  name?: string
  status?: string
  startedAt?: number
  pid?: number
}
type Limit = { window?: number; limit?: number; tokens?: number; at: number }

type Api = EngineInterface

// Module state: rebuilt after a reload, which only costs one re-read.
const entries = new Map<string, Entry>()
const missing = new Map<string, number>()
const alerted = new Set<string>()
let selfLimit: Limit = { at: 0 }
let isTicking = false
let isFirstTick = true

/** Where the next whole line starts at or after `from`. */
async function nextLineStart($: Api, path: string, from: number, size: number) {
  let at = from
  while (at < size) {
    const length = Math.min(1024 * 1024, size - at)
    const { base64 } = (await $.fs.read(path, { as: 'bytes', offset: at, length })) as {
      base64: string
    }
    const bytes = base64Bytes(base64)
    const nl = bytes.indexOf(10)
    if (nl >= 0) return at + nl + 1
    at += length
  }
  return size
}

/** Reads what a transcript gained since the last tick. */
async function pump($: Api, e: Entry, now: number) {
  const st = await $.fs.stat(e.path)
  if (st.size < e.t.offset) e.t = newTracker()
  if (e.size === -1) e.lastGrowMs = st.mtimeMs
  else if (st.size !== e.size) e.lastGrowMs = now
  e.size = st.size
  if (e.t.offset === 0 && st.size > FIRST_READ_MAX) {
    e.t.offset = await nextLineStart($, e.path, st.size - FIRST_READ_MAX, st.size)
  }
  let budget = TICK_BYTES
  while (e.t.offset < st.size && budget > 0) {
    const length = Math.min(CHUNK, st.size - e.t.offset)
    const text = (await $.fs.read(e.path, { offset: e.t.offset, length })) as string
    const used = ingestChunk(e.t, text)
    if (used > 0) e.t.offset += used
    else if (length < CHUNK) break // the last line is still being written
    else e.t.offset = await nextLineStart($, e.path, e.t.offset + length, st.size)
    budget -= length
  }
}

/** The live session records whose folder is inside this project. */
async function liveSessions($: Api, claudeDir: string, root: string) {
  const dir = `${claudeDir}/sessions`
  const out: LiveSession[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    try {
      const s = JSON.parse((await $.fs.read(`${dir}/${f.name}`)) as string)
      if (typeof s.sessionId === 'string' && typeof s.cwd === 'string' && isInside(s.cwd, root)) {
        out.push(s)
      }
    } catch {
      // A record being rewritten right now; the next tick reads it.
    }
  }
  return out
}

/** Finds a session's transcript, even after it changed folders. */
async function transcriptOf($: Api, claudeDir: string, s: LiveSession, now: number) {
  const known = entries.get(s.sessionId)
  if (known) return known.path
  if ((missing.get(s.sessionId) ?? 0) > now) return undefined
  const guess = `${claudeDir}/projects/${projectFolderName(s.cwd)}/${s.sessionId}.jsonl`
  if (await $.fs.exists(guess)) return guess
  for (const p of await $.fs.list(`${claudeDir}/projects`)) {
    const path = `${claudeDir}/projects/${p.name}/${s.sessionId}.jsonl`
    if (p.kind === 'directory' && (await $.fs.exists(path))) return path
  }
  missing.set(s.sessionId, now + 60_000)
  return undefined
}

async function refreshSelfLimit($: Api, now: number) {
  if (now - selfLimit.at < LIMIT_REFRESH_MS) {
    const u = await $.session.usage()
    selfLimit = { ...selfLimit, tokens: u.context.tokens }
    return
  }
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
  const b = u.context.breakdown
  const limit = b ? (b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined) : undefined
  selfLimit = {
    window: u.context.window,
    limit: limit ?? u.context.window,
    tokens: u.context.tokens,
    at: now,
  }
}

function alertOnce(key: string, quiet: boolean, act: () => void) {
  if (alerted.has(key)) return
  alerted.add(key)
  if (!quiet) act()
}

/** Claude Code's config folder, from the environment. */
async function configDir($: Api): Promise<string | undefined> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom.replace(/\\/g, '/')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/\\/g, '/')}/.claude` : undefined
}

// English titles for labels written in another language, kept across sessions.
const LABELS_KEY = 'english-labels'
let labels: Record<string, string> | undefined
let isTranslating = false
/** A label whose translation failed -> when to try it again. */
const retryAt = new Map<string, number>()
const RETRY_MS = 5 * 60_000

/** A label as the pane may show it: English as written, or its stored title. */
function english(text: string | undefined): string | undefined {
  if (!text) return undefined
  return needsEnglish(text) ? labels?.[text] : text
}

/** Gives a few untitled labels a short English title, in the background. */
async function translate($: Api, texts: string[], now: number) {
  if (isTranslating || !labels) return
  const known = labels
  const todo = [...new Set(texts)]
    .filter(t => needsEnglish(t) && !(t in known) && (retryAt.get(t) ?? 0) <= now)
    .slice(0, 4)
  if (todo.length === 0) return
  isTranslating = true
  try {
    for (const text of todo) {
      const r = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        maxTokens: 30,
        timeoutMs: 20_000,
        prompt:
          'Rewrite this task title as a concise English title of at most 6 words, ' +
          'in sentence case. Reply with the title only.\n\n' +
          text,
      })
      const title = r.isAnswered ? cleanTitle(r.text) : undefined
      // A failure (offline, an odd reply) is not stored: it is tried again later.
      if (title) known[text] = title
      else retryAt.set(text, now + RETRY_MS)
    }
    await $.store.set(LABELS_KEY, known)
  } finally {
    isTranslating = false
  }
}

// ---------- This chat's own status, shared with every other pane ----------

/** What this chat knows about itself that its transcript does not say. */
type Own = {
  crons: BeaconCron[]
  background?: BeaconTask[]
  permission?: { tool: string; since: number }
  lastPromptMs?: number
  lastWakeMs?: number
  wakes: number
}
let own: Own = { crons: [], wakes: 0 }
let isOwnRestored = false
let located: { claudeDir: string; selfId: string } | undefined
/** Process ids alive at the last check (undefined: unknown, so trust every record). */
let livePids: Set<string> | undefined
let pidsCheckedAt = 0
const PID_CHECK_MS = 60_000

const beaconDir = (claudeDir: string) => `${claudeDir}/agent-task-hub`

/** Where things are: the project root, this chat, its transcript, the config folder. */
async function locate($: Api) {
  // The project root, where the session started: a shell `cd` into a
  // subfolder must not shrink the hub to that subfolder.
  const root = await $.session.root().catch(() => $.session.cwd())
  const selfId = await $.session.id()
  // The transcript path names the config folder; else the usual places.
  let selfPath: string | undefined
  try {
    selfPath = (await $.session.info()).transcriptPath.replace(/\\/g, '/') || undefined
  } catch {
    selfPath = undefined // not offered here (as under the test kit)
  }
  const claudeDir = selfPath ? selfPath.split('/').slice(0, -3).join('/') : await configDir($)
  if (claudeDir) located = { claudeDir, selfId }
  return { root, selfId, selfPath, claudeDir }
}

/** This chat's beacon as of now. */
function ownBeacon(selfId: string, now: number): Beacon {
  return {
    v: 1,
    sessionId: selfId,
    at: now,
    tokens: selfLimit.tokens,
    window: selfLimit.window,
    limit: selfLimit.limit,
    permission: own.permission,
    crons: own.crons,
    background: own.background,
    lastPromptMs: own.lastPromptMs,
    lastWakeMs: own.lastWakeMs,
    wakes: own.wakes,
  }
}

/** Writes this chat's beacon: only its own file, so chats never overwrite each other. */
async function writeBeacon($: Api, now: number) {
  if (!located) return
  const { claudeDir, selfId } = located
  await $.fs.write(`${beaconDir(claudeDir)}/${selfId}.json`, JSON.stringify(ownBeacon(selfId, now)))
}

/** After a reload, picks up what this chat had published before it. */
async function restoreOwn($: Api) {
  if (isOwnRestored || !located) return
  isOwnRestored = true
  const { claudeDir, selfId } = located
  const text = await $.fs.read(`${beaconDir(claudeDir)}/${selfId}.json`).catch(() => undefined)
  const old = typeof text === 'string' ? parseBeacon(text) : undefined
  if (old) {
    own = {
      crons: old.crons,
      background: old.background,
      lastPromptMs: old.lastPromptMs,
      lastWakeMs: old.lastWakeMs,
      wakes: old.wakes,
    }
  }
}

/** Every chat's beacon, by session id. */
async function readBeacons($: Api, claudeDir: string) {
  const out = new Map<string, Beacon>()
  const dir = beaconDir(claudeDir)
  const files = await $.fs.list(dir).catch(() => [])
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => undefined)
    const b = typeof text === 'string' ? parseBeacon(text) : undefined
    if (b) out.set(b.sessionId, b)
  }
  return out
}

/** Which process ids are alive, checked once a minute; undefined when the check fails. */
async function refreshPids($: Api, claudeDir: string, now: number) {
  if (now - pidsCheckedAt < PID_CHECK_MS) return
  pidsCheckedAt = now
  const isWindows = /^[A-Za-z]:/.test(claudeDir)
  try {
    const r = await $.process.run(isWindows ? ['tasklist', '/FO', 'CSV', '/NH'] : ['ps', '-A', '-o', 'pid='])
    if (r.exitCode !== 0) {
      livePids = undefined
      return
    }
    const pids = new Set<string>()
    for (const line of r.stdout.split('\n')) {
      const pid = isWindows ? /^"[^"]*","(\d+)"/.exec(line.trim())?.[1] : line.trim()
      if (pid && /^\d+$/.test(pid)) pids.add(pid)
    }
    livePids = pids.size > 0 ? pids : undefined
  } catch {
    livePids = undefined
  }
}

/** Applies a change to this chat's own status and publishes it at once. */
async function changeOwn($: Api, change: (o: Own, now: number) => void) {
  const now = await $.clock.now()
  if (!located) await locate($)
  await restoreOwn($)
  change(own, now)
  await writeBeacon($, now).catch(() => undefined)
}

async function tick($: Api) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const { root, selfId, selfPath, claudeDir } = await locate($)
    if (!claudeDir) {
      await update($, hub, h => ({ ...h, note: 'Cannot find the Claude Code config folder.' }))
      return
    }
    await refreshSelfLimit($, now)
    await restoreOwn($)
    await writeBeacon($, now).catch(() => undefined)
    const beacons = await readBeacons($, claudeDir)
    beacons.set(selfId, ownBeacon(selfId, now))
    await refreshPids($, claudeDir, now)
    if (!labels) {
      const stored = await $.store.get(LABELS_KEY)
      labels = stored && typeof stored === 'object' ? { ...(stored as Record<string, string>) } : {}
    }

    // A record whose process is gone (a crash leaves it behind) is not a live chat.
    const live = (await liveSessions($, claudeDir, root)).filter(
      s =>
        s.sessionId === selfId ||
        isFresh(beacons.get(s.sessionId), now) ||
        livePids === undefined ||
        s.pid === undefined ||
        livePids.has(String(s.pid)),
    )
    if (!live.some(s => s.sessionId === selfId)) {
      live.push({ sessionId: selfId, cwd: root, status: 'busy' })
    }

    const views: SessionView[] = []
    const editLists: { id: string; name: string; edits: Record<string, number> }[] = []
    let selfModel: string | undefined
    for (const s of live) {
      const isSelf = s.sessionId === selfId
      const path = (isSelf && selfPath) || (await transcriptOf($, claudeDir, s, now))
      if (!path) continue
      let e = entries.get(s.sessionId)
      if (!e) {
        e = { t: newTracker(), path, size: -1, lastGrowMs: now }
        entries.set(s.sessionId, e)
      }
      try {
        await pump($, e, now)
      } catch {
        continue
      }
      if (isSelf) selfModel = e.t.model
    }

    const foreign: string[] = []
    for (const s of live) {
      const e = entries.get(s.sessionId)
      if (!e) continue
      const t = e.t
      const isSelf = s.sessionId === selfId
      // The chat's name exactly as the sidebar shows it, in whatever language,
      // so a row here is easy to find there. Everything else stays English.
      const name = s.name || t.title || `Session ${s.sessionId.slice(0, 4)}`
      const rawStep = t.plan.find(x => x.status === 'in_progress')?.content
      if (rawStep && needsEnglish(rawStep)) foreign.push(rawStep)
      const status = isSelf ? 'busy' : (s.status ?? 'unknown')
      // A chat's own beacon is exact; without one, estimate as before.
      const b = beacons.get(s.sessionId)
      const beacon = isFresh(b, now) ? b : undefined
      const sameModel = isSelf || t.model === undefined || t.model === selfModel
      const limit = beacon?.limit ?? (sameModel ? selfLimit.limit : undefined)
      const context = isSelf ? (selfLimit.tokens ?? t.context) : (beacon?.tokens ?? t.context)
      const f = forecast({ plan: t.plan, marks: t.marks, context }, limit)
      const startedAt = s.startedAt ?? 0
      // Idle: the engine's own list from the end of the last turn; busy: the transcript's.
      const workLabels =
        status === 'idle' && beacon?.background !== undefined
          ? beacon.background.map(x => x.description)
          : Object.values(t.background)
              .filter(x => x.ms >= startedAt)
              .map(x => x.label)
      const background = workLabels.map(label => {
        if (needsEnglish(label)) foreign.push(label)
        return english(label) ?? 'Background task'
      })
      let needs: string | undefined
      let needsKey: string | undefined
      if (beacon?.permission) {
        needs = `Needs your approval: ${beacon.permission.tool}`
        needsKey = `perm:${beacon.permission.since}`
      } else if (t.openQuestions.length > 0) {
        needs = 'Has a question'
        needsKey = `q:${t.openQuestions[t.openQuestions.length - 1]}`
      } else if (status === 'idle' && t.pendingAsk) {
        needs = 'Waiting for your decision'
        needsKey = `ask:${t.askMs}`
      } else if (status !== 'idle' && status !== 'busy') {
        needs = 'Waiting'
        needsKey = `status:${status}:${t.lastEventMs}`
      }
      // Quiet while busy: a long command still running is fine; nothing at all may be stuck.
      const quiet = status === 'busy' && !isSelf ? now - e.lastGrowMs : 0
      const oldest = Object.values(t.running).sort((a, b) => a.ms - b.ms)[0]
      if (oldest && needsEnglish(oldest.label)) foreign.push(oldest.label)
      const isLongRun = quiet >= QUIET_MS && oldest !== undefined
      const folder = projectOf(s.cwd, root, t.edits, t.reads)
      if (folder && needsEnglish(folder)) foreign.push(folder)
      views.push({
        id: s.sessionId,
        name,
        project: english(folder),
        isSelf,
        status,
        needs,
        stepsDone: t.plan.filter(x => x.status === 'completed').length,
        stepsTotal: t.plan.length,
        currentStep: english(rawStep),
        context,
        limit,
        perStep: f.perStep,
        need: f.need,
        room: f.room,
        verdict: f.verdict,
        compactions: t.compactions,
        background,
        lastEventMs: t.lastEventMs,
        quietMs: quiet >= QUIET_MS && !isLongRun ? quiet : undefined,
        runningLabel: isLongRun ? (english(oldest.label) ?? 'A command') : undefined,
        runningMs: isLongRun ? now - oldest.ms : undefined,
        needsKey,
        scheduled: beacon ? scheduleLine(beacon.crons, now) : undefined,
        lastWakeMs: beacon?.lastWakeMs,
      })
      // Only project files count: Claude's own folders (memory, plans) are
      // shared by every chat by design.
      const projectEdits = Object.fromEntries(
        Object.entries(t.edits).filter(([path]) => isInside(path, root)),
      )
      editLists.push({ id: s.sessionId, name, edits: projectEdits })
    }

    const rank = (v: SessionView) => (v.needs ? 0 : v.status === 'busy' ? 1 : 2)
    views.sort((a, b) => rank(a) - rank(b) || (b.lastEventMs ?? 0) - (a.lastEventMs ?? 0))
    // Matched case-blind (Windows paths), shown as a session spelled them.
    const spelled = (path: string) => {
      for (const e of entries.values()) if (e.t.spelling[path]) return e.t.spelling[path]
      return path
    }
    const conflicts: ConflictView[] = findConflicts(editLists, now - CONFLICT_MS).map(c => ({
      ...c,
      path: spelled(c.path),
    }))

    // Alerts: each fires once. The first tick only records what is already there.
    // Only the chat the person typed in last shows them, so they appear once.
    const announcer = pickAnnouncer([...beacons.values()], now)
    const quietStart = isFirstTick || (announcer !== undefined && announcer !== selfId)
    for (const v of views) {
      if (v.needs && !v.isSelf) {
        alertOnce(`${v.id}:needs:${v.needsKey}`, quietStart, () => {
          void $.ui.toast(`${v.name}: ${v.needs}`)
        })
      }
      if (v.quietMs !== undefined) {
        alertOnce(`${v.id}:quiet:${v.lastEventMs}`, quietStart, () => {
          void $.ui.toast(`${v.name}: no activity for ${formatAge(v.quietMs ?? 0)}, it may be stuck`)
        })
      }
      if (v.verdict === 'over' && !v.isSelf) {
        alertOnce(`${v.id}:over:${v.compactions}`, quietStart, () => {
          void $.ui.toast(`${v.name}: the rest of its plan likely will not fit before auto-compaction`)
        })
      }
      if (v.isSelf && v.limit !== undefined && v.context !== undefined) {
        const isNear = v.context >= v.limit * NOTE_AT || v.verdict === 'over'
        if (isNear) {
          // Tell this session's model once per compaction cycle.
          alertOnce(`${v.id}:note:${v.compactions}`, false, () => {
            const plan =
              v.stepsTotal > 0
                ? ` ${v.stepsTotal - v.stepsDone} plan steps remain, about ${formatTokens(v.need)} tokens at the recent pace.`
                : ''
            void $.session
              .append({
                message: {
                  type: 'user',
                  content: [
                    {
                      type: 'text',
                      text:
                        `Agent Task Hub: context is at ${formatTokens(v.context)} of the ${formatTokens(v.limit)} auto-compaction point.${plan} ` +
                        'Before starting another large step, finish the current one and leave a short handoff note (what is done, what is left, key decisions), or suggest moving the rest to a new session.',
                    },
                  ],
                },
              })
              .catch(() => undefined)
            void $.ui.toast(`This session's context is near auto-compaction (${formatTokens(v.context)} of ${formatTokens(v.limit)})`)
          })
        }
      }
    }
    for (const c of conflicts) {
      alertOnce(`conflict:${c.path}:${c.sessions.join('|')}`, quietStart, () => {
        void $.ui.toast(`Same file edited by ${c.sessions.join(' and ')}: ${c.path}`)
      })
    }
    isFirstTick = false
    void translate($, foreign, now).catch(() => undefined)

    const project = root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? root
    await update($, hub, () => ({ project, updatedAt: now, sessions: views, conflicts }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, hub, h => ({ ...h, note: `Last refresh failed: ${message}` })).catch(() => undefined)
  } finally {
    isTicking = false
  }
}

export const register: Register = (on, options) => {
  // Off: the pane waits for /task-hub instead of opening in every new chat.
  const openOnStart = options.openOnStart !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'task-hub',
      description: 'Open the Agent Task Hub pane: every session in this project at a glance',
    })
    // No window to draw in (a headless run) is fine: /task-hub opens it later.
    if (openOnStart) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    void tick($)
    $.clock.every(TICK_MS, () => {
      void tick($)
    })
    return started
  })

  // ----- What this chat learns about itself, published in its beacon -----

  // End of a turn: the engine's own list of scheduled wake-ups and background work.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await changeOwn($, o => {
      o.crons = (e.session_crons ?? []).map(c => ({
        id: c.id,
        schedule: c.schedule,
        recurring: c.recurring,
        prompt: c.prompt.slice(0, 200),
      }))
      o.background = (e.background_tasks ?? []).map(t => ({
        type: t.type,
        status: t.status,
        description: t.description.slice(0, 200),
      }))
      o.permission = undefined
    })
    return result
  })

  // A permission dialog is about to ask the person: this chat now waits on them.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    const isDecided = (result as { decision?: unknown } | undefined)?.decision !== undefined
    if (!isDecided) {
      await changeOwn($, (o, now) => {
        o.permission = { tool: e.tool_name, since: now }
      })
    }
    return result
  })

  // The tool ran, failed or was refused: the dialog is gone.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (own.permission) await changeOwn($, o => (o.permission = undefined))
    return result
  })
  on('classic.PostToolUseFailure', async ($, e, next) => {
    const result = await next(e)
    if (own.permission) await changeOwn($, o => (o.permission = undefined))
    return result
  })
  on('classic.PermissionDenied', async ($, e, next) => {
    const result = await next(e)
    if (own.permission) await changeOwn($, o => (o.permission = undefined))
    return result
  })

  // A prompt: typed by the person (this chat is now in front of them), or a scheduled wake-up.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    // A run with no window (`claude -p`, a script) is nobody's chat in front of
    // them: it must not take over the toasts.
    const hasWindow = (await $.session.surfaces()).length > 0
    await changeOwn($, (o, now) => {
      o.permission = undefined
      if (e.source === 'loop_wakeup' || e.source === 'schedule_wakeup') {
        o.lastWakeMs = now
        o.wakes += 1
      } else if (hasWindow && (e.source === undefined || e.source === 'user')) {
        o.lastPromptMs = now
      }
    })
    return result
  })

  on('command.run', { command: 'task-hub' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void tick($)
    return { text: 'Agent Task Hub pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const state = await read($, hub)
    const isEarlierOpen = await read($, showEarlier)
    const now = await $.clock.now()

    if (state.updatedAt === 0) {
      return (
        <Box flexDirection="column" paddingX={2} paddingY={2}>
          <Text dimColor size="caption">
            {state.note ?? 'Reading sessions…'}
          </Text>
        </Box>
      )
    }

    const waiting = state.sessions.filter(v => v.needs && !v.isSelf).length
    const working = state.sessions.filter(v => v.status === 'busy').length
    const scheduledCount = state.sessions.filter(v => v.scheduled).length
    const summary = [
      `${state.sessions.length} ${state.sessions.length === 1 ? 'session' : 'sessions'}`,
      working > 0 ? `${working} working` : '',
      waiting > 0 ? `${waiting} waiting` : '',
      scheduledCount > 0 ? `${scheduledCount} scheduled` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    // A labelled row: a dim label in a fixed column, then the value.
    const field = (label: string, value: unknown) => (
      <Box flexDirection="row" gap={1}>
        <Box width={11} flexShrink={0}>
          <Text size="caption" dimColor>
            {label}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {value}
        </Box>
      </Box>
    )

    // Chats idle for over an hour fold into one line, so the live ones stand out.
    // One with scheduled work is not idle in spirit: it stays in view.
    const isEarlier = (v: SessionView) =>
      !v.isSelf &&
      v.status === 'idle' &&
      v.scheduled === undefined &&
      v.lastEventMs !== undefined &&
      now - v.lastEventMs > EARLIER_MS
    const recent = state.sessions.filter(v => !isEarlier(v))
    const earlier = state.sessions.filter(isEarlier)
    const earlierWaiting = earlier.filter(v => v.needs).length

    const session = (v: SessionView) => {
      // Three states, three colours: waiting on you, working, idle.
      const isWaiting = v.needs !== undefined && !v.isSelf
      const markColor = isWaiting ? 'warning' : v.status === 'busy' ? 'suggestion' : 'subtle'
      const status = isWaiting
        ? { text: v.needs?.startsWith('Needs your approval') ? 'Needs approval' : 'Waiting for you', color: 'warning' }
        : v.status === 'busy'
          ? { text: v.isSelf ? 'This chat' : 'Working', color: 'suggestion' }
          : {
              text: v.lastEventMs !== undefined ? `Idle ${formatAge(now - v.lastEventMs)}` : 'Idle',
              color: 'subtle',
            }

      const isDone = v.stepsTotal > 0 && v.stepsDone === v.stepsTotal
      const step = Math.min(v.stepsDone + 1, v.stepsTotal)
      const plan =
        v.stepsTotal === 0 ? (
          <Text dimColor>
            No plan
          </Text>
        ) : isDone ? (
          <Text color="success">
            Done · {v.stepsTotal} steps
          </Text>
        ) : Progress ? (
          <Progress
            label={v.currentStep ?? 'In progress'}
            // The step in hand counts half, so a plan at 0/5 still shows it has begun.
            value={v.stepsDone + (v.currentStep ? 0.5 : 0)}
            max={v.stepsTotal}
            valueText={`Step ${step} of ${v.stepsTotal}`}
          />
        ) : (
          <Text wrap="truncate-end">
            Step {step} of {v.stepsTotal} · {v.currentStep ?? 'In progress'}
          </Text>
        )

      const verdict = verdictLabel(v)
      const percent =
        v.context !== undefined && v.limit ? ` (${Math.round((v.context / v.limit) * 100)}%)` : ''
      const context =
        v.context === undefined ? undefined : (
          <Box flexDirection="row" gap={1}>
            <Text tabular>
              {formatTokens(v.context)}
              {v.limit !== undefined ? ` of ${formatTokens(v.limit)}` : ' used'}
              {percent}
            </Text>
            {verdict && (
              <Text color={verdict.color} wrap="truncate-end">
                {verdict.text}
              </Text>
            )}
          </Box>
        )

      return (
        <Box key={v.id} flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
              <Text color={markColor}>●</Text>
              <Text weight="semibold" wrap="truncate-end">
                {v.name}
              </Text>
            </Box>
            {/* The status never wraps: the name gives way first. */}
            <Box flexShrink={0}>
              <Text size="caption" weight="medium" color={status.color} wrap="truncate-end">
                {status.text}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            {v.project &&
              field(
                'Project',
                <Text weight="medium" wrap="truncate-end">
                  {v.project}
                </Text>,
              )}
            {field('Plan', plan)}
            {context && field('Context', context)}
            {v.background.length > 0 &&
              field(
                'Background',
                <Text wrap="truncate-end">
                  {v.background.length} running
                </Text>,
              )}
            {v.scheduled !== undefined &&
              field(
                'Scheduled',
                <Text wrap="truncate-end">
                  {v.scheduled}
                  {v.lastWakeMs !== undefined ? ` · last ran ${formatAge(now - v.lastWakeMs)} ago` : ''}
                </Text>,
              )}
            {v.needs?.startsWith('Needs your approval') &&
              !v.isSelf &&
              field(
                'Approval',
                <Text color="warning" wrap="truncate-end">
                  {v.needs.replace('Needs your approval: ', '')} is waiting for Allow
                </Text>,
              )}
            {v.runningLabel !== undefined &&
              field(
                'Running',
                <Text wrap="truncate-end">
                  {v.runningLabel} · {formatAge(v.runningMs ?? 0)}
                </Text>,
              )}
          </Box>
          {v.quietMs !== undefined && (
            <Text size="caption" color="warning">
              No activity for {formatAge(v.quietMs)}: it may be stuck
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={2} paddingY={2} gap={2}>
        <Box flexDirection="column">
          <Text size="heading" weight="semibold" wrap="truncate-end">
            {state.project}
          </Text>
          <Text size="caption" dimColor tabular>
            {summary}
          </Text>
          {state.note && (
            <Text size="caption" color="error">
              {state.note}
            </Text>
          )}
        </Box>

        {state.conflicts.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {state.conflicts.map(c => (
              <Box key={`c-${c.path}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color="error">▲</Text>
                  <Text size="caption" weight="medium" color="error" wrap="truncate-start">
                    {`Same file edited by ${c.sessions.length} chats: ${c.path.split('/').slice(-2).join('/')}`}
                  </Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text size="caption" dimColor wrap="wrap">
                    {c.sessions.join(', ')}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column" gap={2}>
          {recent.map(session)}
        </Box>

        {earlier.length > 0 && (
          <Box flexDirection="column" gap={2}>
            <Button
              key="earlier"
              plain
              dimColor
              label={`${isEarlierOpen ? 'Hide' : 'Show'} ${earlier.length} earlier ${earlier.length === 1 ? 'chat' : 'chats'}${earlierWaiting > 0 ? ` · ${earlierWaiting} waiting` : ''}`}
              onPress={() => update($, showEarlier, open => !open)}
            />
            {isEarlierOpen && earlier.map(session)}
          </Box>
        )}
      </Box>
    )
  })
}
