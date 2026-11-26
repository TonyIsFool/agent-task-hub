import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ConflictView, Hub, SessionView } from '../types'
import {
  base64Bytes,
  utf8Decode,
  cleanTitle,
  findConflicts,
  forecast,
  formatAge,
  formatTokens,
  fullColor,
  ingestChunk,
  isInside,
  nameList,
  statusSummary,
  timeLeft,
  usageName,
  needsEnglish,
  newTracker,
  projectOf,
  projectFolderName,
  toolLabel,
  verdictLabel,
} from './parse'
import type { Tracker } from './parse'
import {
  BEACON_FRESH_MS,
  isFresh,
  parseBeacon,
  parsePidList,
  pickAnnouncer,
  scheduleLine,
  staleBeaconFiles,
} from './beacon'
import type { Beacon, BeaconCron, BeaconTask } from './beacon'

const PANE = 'agent-task-hub'
const TITLE = 'Agent Task Hub'

const TICK_MS = 5_000
const LIMIT_REFRESH_MS = 60_000
/** Busy with no transcript change for this long counts as possibly stuck. */
const QUIET_MS = 10 * 60_000
/** Edits older than this do not count toward a conflict. */
const CONFLICT_MS = 2 * 60 * 60_000
/**
 * On first sight only a transcript's last few MB are read: that is where its current
 * state is, so every chat shows within one refresh. If the plan began further back,
 * the read starts over from DEEP_READ_MAX before the end.
 */
const FIRST_READ_MAX = 4 * 1024 * 1024
const DEEP_READ_MAX = 24 * 1024 * 1024
/** Most bytes read from one transcript per tick, so a tick stays short. */
const TICK_BYTES = 8 * 1024 * 1024
const CHUNK = 3 * 1024 * 1024
/** Share of the compaction limit at which this session is told to wrap up. */
const NOTE_AT = 0.85
/** Pane widths (cells) for the labelled layout, and below which a chat takes one line. */
const WIDE_COLUMNS = 48
const TINY_COLUMNS = 28
/** Chats idle for longer than this fold into one line at the bottom. */
const EARLIER_MS = 60 * 60_000

const EMPTY: Hub = { project: '', updatedAt: 0, sessions: [], conflicts: [] }
// Change the shape tag when Hub's fields change: it declines older values.
const hub = atom({ plugin: 'agent-task-hub', key: 'hub' } as const, EMPTY, { shape: 'hub-6' })
/** Whether chats idle for over an hour are unfolded. */
const showEarlier = atom({ plugin: 'agent-task-hub', key: 'showEarlier' } as const, false)
/**
 * The near-compaction reminder last sent (chat id and compaction count). Kept in the
 * session's state, which a reload keeps: `/reload-plugins` must not send it again.
 */
const NOTED = { plugin: 'agent-task-hub', key: 'noted' } as const

type Entry = {
  t: Tracker
  path: string
  size: number
  lastGrowMs: number
  isDeep?: boolean
  /** When the chat was last among the live ones. */
  seenMs: number
}
/** A chat gone for this long is dropped from memory (it is read again if it comes back). */
const FORGET_MS = 10 * 60_000
type LiveSession = {
  sessionId: string
  cwd: string
  name?: string
  status?: string
  startedAt?: number
  pid?: number
}
type Limit = {
  window?: number
  limit?: number
  tokens?: number
  at: number
  /** Whether auto-compaction is on; off, the limit is the whole window. Undefined: not known. */
  isAuto?: boolean
}

type Api = EngineInterface

// Module state: rebuilt after a reload, which only costs one re-read.
const entries = new Map<string, Entry>()
const missing = new Map<string, number>()
const alerted = new Set<string>()
let selfLimit: Limit = { at: 0 }
let isTicking = false
/** Each chat's status at the last full refresh: busy then idle is a chat that finished. */
const lastStatus = new Map<string, string>()
/** The status line as last set, so it is set only on a change. */
let lastStatusText: string | undefined
/** No refresh has read every chat yet: alerts then only note what is already there. */
let isFirstTick = true
/** The last refresh had no window, so read only this chat: a drawing needs a full one. */
let isOwnOnly = false

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
  if (st.size < e.t.offset) e.t = newTracker(e.t.ownId)
  if (e.size === -1) e.lastGrowMs = st.mtimeMs
  else if (st.size !== e.size) e.lastGrowMs = now
  e.size = st.size
  if (e.t.offset === 0 && st.size > FIRST_READ_MAX) {
    e.t.offset = await nextLineStart($, e.path, st.size - FIRST_READ_MAX, st.size)
  }
  let budget = TICK_BYTES
  while (e.t.offset < st.size && budget > 0) {
    const length = Math.min(CHUNK, st.size - e.t.offset)
    const text = await readRange($, e.path, e.t.offset, length)
    const used = ingestChunk(e.t, text)
    if (used > 0) e.t.offset += used
    else if (length < CHUNK) break // the last line is still being written
    else e.t.offset = await nextLineStart($, e.path, e.t.offset + length, st.size)
    budget -= length
  }
  // The tail held plan steps but not the plan they belong to: read further back once.
  if (e.t.offset >= st.size && e.t.isPlanOrphan && !e.isDeep && st.size > FIRST_READ_MAX) {
    e.isDeep = true
    e.t = newTracker(e.t.ownId)
    e.t.offset = await nextLineStart($, e.path, Math.max(0, st.size - DEEP_READ_MAX), st.size)
  }
}

/**
 * Reads a byte range of a file as text. Some Claude Code versions refuse a text read of
 * a file over 4 MB even for a small range; a byte read of the same range is decoded here.
 */
async function readRange($: Api, path: string, offset: number, length: number): Promise<string> {
  try {
    return (await $.fs.read(path, { offset, length })) as string
  } catch {
    const { base64 } = (await $.fs.read(path, { as: 'bytes', offset, length })) as { base64: string }
    return utf8Decode(base64Bytes(base64))
  }
}

/** The live session records whose folder is inside this project. */
async function liveSessions($: Api, claudeDir: string, root: string) {
  const dir = `${claudeDir}/sessions`
  const out: LiveSession[] = []
  const names = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  await Promise.all(
    names.map(async f => {
      try {
        const s = JSON.parse((await $.fs.read(`${dir}/${f.name}`)) as string)
        if (typeof s.sessionId === 'string' && typeof s.cwd === 'string' && isInside(s.cwd, root)) {
          out.push(s)
        }
      } catch {
        // A record being rewritten right now; the next tick reads it.
      }
    }),
  )
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

/** The account's usage windows as last read (empty off a subscription). */
let usageWindows: { kind: string; percent: number }[] = []

async function refreshSelfLimit($: Api, now: number) {
  if (now - selfLimit.at < LIMIT_REFRESH_MS) {
    const u = await $.session.usage()
    selfLimit = { ...selfLimit, tokens: u.context.tokens }
    usageWindows = (u.rateLimits ?? []).map(r => ({ kind: r.kind, percent: r.percentUsed }))
    return
  }
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
  usageWindows = (u.rateLimits ?? []).map(r => ({ kind: r.kind, percent: r.percentUsed }))
  const b = u.context.breakdown
  const limit = b ? (b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined) : undefined
  selfLimit = {
    window: u.context.window,
    limit: limit ?? u.context.window,
    tokens: u.context.tokens,
    at: now,
    isAuto: b ? b.isAutoCompactEnabled : undefined,
  }
}

function alertOnce(key: string, quiet: boolean, act: () => void) {
  if (alerted.has(key)) return
  alerted.add(key)
  if (!quiet) act()
}

/** Whether new chats open the pane by themselves (set with /task-hub auto on|off; on by default). */
const AUTO_OPEN_KEY = 'open-on-start'
/** Whether toasts are muted (set with /task-hub quiet on|off; off by default). */
const QUIET_KEY = 'quiet'
async function opensOnStart($: Api): Promise<boolean> {
  return (await $.store.get(AUTO_OPEN_KEY).catch(() => undefined)) !== false
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

async function loadLabels($: Api) {
  const stored = await $.store.get(LABELS_KEY)
  labels = stored && typeof stored === 'object' ? { ...(stored as Record<string, string>) } : {}
}

/** A label as the pane may show it: English as written, or its stored title. */
function english(text: string | undefined): string | undefined {
  if (!text) return undefined
  if (!needsEnglish(text)) return text
  const title = labels?.[text]
  if (labels && title !== undefined) {
    // Move it to the end: the store keeps the most recently used titles.
    delete labels[text]
    labels[text] = title
  }
  return title
}

/** How many English titles the store keeps. */
const LABELS_MAX = 500

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
    const keep = Object.keys(known).slice(-LABELS_MAX)
    labels = Object.fromEntries(keep.map(k => [k, known[k]]))
    await $.store.set(LABELS_KEY, labels)
  } finally {
    isTranslating = false
  }
}

// ---------- This chat's own status, shared with every other pane ----------

/** What this chat knows about itself that its transcript does not say. */
type Own = {
  crons: BeaconCron[]
  background?: BeaconTask[]
  /** The open dialog, and the agent (subagent id; absent for the chat itself) that raised it. */
  permission?: { tool: string; since: number; agent?: string }
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

type Place = { root: string; selfId: string; selfPath?: string; claudeDir?: string }
let place: { value: Place; at: number } | undefined
const PLACE_MS = 60_000

/** Where things are: the project root, this chat, its transcript, the config folder. */
async function locate($: Api): Promise<Place> {
  const now = await $.clock.now()
  // After a /clear this process goes on as a new chat, under a new session id, and
  // no session.start says so: a changed id starts this chat's own status over.
  if (place && (await $.session.id()) !== place.value.selfId) startOver()
  if (place && now - place.at < PLACE_MS) return place.value
  const value = await findPlace($)
  place = { value, at: now }
  return value
}

async function findPlace($: Api): Promise<Place> {
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

/** Forgets what this process knew about itself as the chat before a /clear. */
function startOver() {
  place = undefined
  located = undefined
  own = { crons: [], wakes: 0 }
  isOwnRestored = false
  lastWrite = { content: '', at: 0 }
  selfLimit = { at: 0 }
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
    permission: own.permission && { tool: own.permission.tool, since: own.permission.since },
    crons: own.crons,
    background: own.background,
    lastPromptMs: own.lastPromptMs,
    lastWakeMs: own.lastWakeMs,
    wakes: own.wakes,
  }
}

/** A heartbeat this often keeps the beacon fresh (BEACON_FRESH_MS is 90 s) with few writes. */
const HEARTBEAT_MS = 30_000
let lastWrite = { content: '', at: 0 }

/**
 * Writes this chat's beacon: only its own file, so chats never overwrite each other.
 * Only when something changed, or for the heartbeat; `force` for a change just made.
 */
async function writeBeacon($: Api, now: number, force = false) {
  if (!located) return
  const { claudeDir, selfId } = located
  const beacon = ownBeacon(selfId, now)
  const content = JSON.stringify({ ...beacon, at: 0 })
  if (!force && content === lastWrite.content && now - lastWrite.at < HEARTBEAT_MS) return
  await $.fs.write(`${beaconDir(claudeDir)}/${selfId}.json`, JSON.stringify(beacon))
  lastWrite = { content, at: now }
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

/**
 * Every live chat's beacon, by session id. A file not written for longer than a
 * beacon stays fresh belongs to a chat that has stopped: it is skipped unread, so
 * the files of every chat ever opened cost one directory listing, not a read each.
 */
async function readBeacons($: Api, claudeDir: string, now: number) {
  const out = new Map<string, Beacon>()
  const dir = beaconDir(claudeDir)
  const files = await $.fs.list(dir).catch(() => [])
  const fresh = files.filter(
    f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs <= BEACON_FRESH_MS,
  )
  await Promise.all(
    fresh.map(async f => {
      const text = await $.fs.read(`${dir}/${f.name}`).catch(() => undefined)
      const b = typeof text === 'string' ? parseBeacon(text) : undefined
      if (b) out.set(b.sessionId, b)
    }),
  )
  return out
}

const PRUNE_KEY = 'pruned-at'
const PRUNE_EVERY_MS = 24 * 60 * 60_000
/** A status file not written for a week belongs to a chat long gone. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000
let pruneCheckedAt = 0

/**
 * Deletes the status files of chats gone for over a week, once a day across every
 * chat (the store says when it last ran). The engine has no file delete, so this
 * runs `del` (Windows) or `rm` in the status folder, naming only files the mod wrote.
 */
async function pruneBeacons($: Api, claudeDir: string, now: number) {
  if (now - pruneCheckedAt < 60 * 60_000) return
  pruneCheckedAt = now
  const last = Number(await $.store.get(PRUNE_KEY).catch(() => 0)) || 0
  if (now - last < PRUNE_EVERY_MS) return
  await $.store.set(PRUNE_KEY, now)
  const dir = beaconDir(claudeDir)
  const names = staleBeaconFiles(await $.fs.list(dir).catch(() => []), now, PRUNE_AFTER_MS)
  const isWindows = /^[A-Za-z]:/.test(claudeDir)
  // Bare names (a UUID each) in the folder itself: nothing to quote, nothing elsewhere.
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40)
    await $.process.run(isWindows ? ['cmd', '/c', 'del', '/q', ...batch] : ['rm', '-f', ...batch], {
      cwd: dir,
      timeoutMs: 10_000,
    })
  }
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
    const pids = parsePidList(r.stdout, isWindows)
    livePids = pids.size > 0 ? pids : undefined
  } catch {
    livePids = undefined
  }
}

/** Records a prompt: typed by the person (this chat is now in front of them), or a wake-up. */
async function notePrompt($: Api, source: string | undefined) {
  // A run with no window (`claude -p`, a script) is nobody's chat in front of
  // them: it must not take over the toasts.
  const hasWindow = (await $.session.surfaces()).length > 0
  await changeOwn($, (o, now) => {
    o.permission = undefined
    if (source === 'loop_wakeup' || source === 'schedule_wakeup') {
      o.lastWakeMs = now
      o.wakes += 1
    } else if (hasWindow && (source === undefined || source === 'user')) {
      o.lastPromptMs = now
    }
  })
  await keepTicking($)
}

/** The dialog an agent raised is gone: its tool ran, failed or was refused, or its turn ended. */
async function closeDialog($: Api, agent: string | undefined) {
  if (own.permission && own.permission.agent === agent) {
    await changeOwn($, o => (o.permission = undefined))
  }
}

/** Applies a change to this chat's own status and publishes it at once. */
async function changeOwn($: Api, change: (o: Own, now: number) => void) {
  const now = await $.clock.now()
  // Asked every time: it notices a /clear before the change lands on the old chat.
  await locate($)
  await restoreOwn($)
  change(own, now)
  await writeBeacon($, now, true).catch(() => undefined)
}

/** When the pane was last drawn: a pane nobody sees refreshes less often. */
let lastDrawnAt = 0
let lastTickAt = 0
const HIDDEN_TICK_MS = 30_000
const SHOWN_GRACE_MS = 15_000

let timer: Timer | undefined
/** No refresh for this long means the timer stopped (a hidden pane refreshes every 30 s). */
const TIMER_LOST_MS = 3 * HIDDEN_TICK_MS

/** Refreshes every 5 s from now on, replacing any earlier timer. */
function startTimer($: Api) {
  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

/**
 * Restarts the refreshes if they stopped. A /clear starts no session.start, so if the
 * engine ended the old chat's timer, the next prompt or turn end brings it back.
 */
async function keepTicking($: Api) {
  const now = await $.clock.now()
  if (lastTickAt === 0 || now - lastTickAt < TIMER_LOST_MS) return
  startTimer($)
  void tick($, true)
}

async function tick($: Api, force = false) {
  if (isTicking) return
  if (!force) {
    const at = await $.clock.now()
    if (at - lastDrawnAt > SHOWN_GRACE_MS && at - lastTickAt < HIDDEN_TICK_MS) return
  }
  isTicking = true
  try {
    const now = await $.clock.now()
    lastTickAt = now
    const { root, selfId, selfPath, claudeDir } = await locate($)
    if (!claudeDir) {
      await update($, hub, h => ({ ...h, note: 'Cannot find the Claude Code config folder.' }))
      return
    }
    // With no window (`claude -p`, a script, a chat not on screen) nothing draws the
    // pane: only this chat's own part is kept (its status file and its reminder).
    const hasWindow = (await $.session.surfaces().catch(() => [])).length > 0
    isOwnOnly = !hasWindow
    // Independent reads run side by side.
    const [, , beacons, records] = await Promise.all([
      refreshSelfLimit($, now),
      restoreOwn($),
      hasWindow ? readBeacons($, claudeDir, now) : new Map<string, Beacon>(),
      hasWindow ? liveSessions($, claudeDir, root) : ([] as LiveSession[]),
      labels ? Promise.resolve() : loadLabels($),
    ])
    await writeBeacon($, now).catch(() => undefined)
    beacons.set(selfId, ownBeacon(selfId, now))
    void pruneBeacons($, claudeDir, now).catch(() => undefined)

    // A record whose process is gone (a crash leaves it behind) is not a live chat.
    // A fresh beacon already proves a chat alive: the process list is needed only
    // for chats without one (opened before the install, or stopped).
    if (records.some(s => s.sessionId !== selfId && !isFresh(beacons.get(s.sessionId), now))) {
      await refreshPids($, claudeDir, now)
    }
    const live = records.filter(
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
    // Every chat's transcript at once.
    await Promise.all(
      live.map(async s => {
        const isSelf = s.sessionId === selfId
        const path = (isSelf && selfPath) || (await transcriptOf($, claudeDir, s, now))
        if (!path) return
        let e = entries.get(s.sessionId)
        if (!e) {
          e = { t: newTracker(s.sessionId), path, size: -1, lastGrowMs: now, seenMs: now }
          entries.set(s.sessionId, e)
        }
        e.seenMs = now
        await pump($, e, now).catch(() => undefined)
      }),
    )
    selfModel = entries.get(selfId)?.t.model
    // A long-open pane would otherwise keep every chat it ever saw in memory. Only a
    // refresh that saw every chat can tell which are gone.
    if (hasWindow) {
      for (const [id, e] of entries) {
        if (now - e.seenMs <= FORGET_MS) continue
        entries.delete(id)
        lastStatus.delete(id)
        for (const key of alerted) if (key.startsWith(`${id}:`)) alerted.delete(key)
      }
      for (const [id, until] of missing) if (until < now) missing.delete(id)
      for (const [text, at] of retryAt) if (at <= now) retryAt.delete(text)
    }

    const foreign: string[] = []
    for (const s of live) {
      const e = entries.get(s.sessionId)
      if (!e) continue
      const t = e.t
      const isSelf = s.sessionId === selfId
      // The chat's name exactly as the sidebar shows it, in whatever language,
      // so a row here is easy to find there. Everything else stays English.
      const name = s.name || t.title || `Chat ${s.sessionId.slice(0, 4)}`
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
        needs = `Needs your approval: ${toolLabel(beacon.permission.tool)}`
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
      // A chat waiting on the person (an open dialog) is quiet by design, not stuck.
      const quiet = status === 'busy' && !isSelf && needs === undefined ? now - e.lastGrowMs : 0
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
        leftMs: timeLeft(t.markTimes, t.plan.filter(x => x.status !== 'completed').length),
        lastWakeMs: beacon?.lastWakeMs,
        lastPromptMs: beacon?.lastPromptMs,
      })
      // Only project files count: Claude's own folders (memory, plans) are
      // shared by every chat by design. Only the chat's own edits: a fork's copied
      // history is its parent's work, not a second chat on the same file.
      const projectEdits = Object.fromEntries(
        Object.entries(t.ownEdits).filter(([path]) => isInside(path, root)),
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

    // AGENT_TASK_HUB_NOTE_AT (a share such as 0.01) lowers the reminder threshold, for checks.
    const noteAtText = await $.env.get('AGENT_TASK_HUB_NOTE_AT')
    const noteAt = noteAtText && Number(noteAtText) > 0 && Number(noteAtText) < 1 ? Number(noteAtText) : NOTE_AT

    // Alerts: each fires once. The first tick only records what is already there.
    // Only the chat the person typed in last shows them, so they appear once.
    const announcer = pickAnnouncer([...beacons.values()], now)
    // `/task-hub quiet on` keeps the pane up to date and shows no toasts.
    const isMuted = (await $.store.get(QUIET_KEY).catch(() => undefined)) === true
    const quietStart = isFirstTick || isMuted || (announcer !== undefined && announcer !== selfId)
    for (const v of views) {
      if (v.needs && !v.isSelf) {
        alertOnce(`${v.id}:needs:${v.needsKey}`, quietStart, () => {
          void $.ui.toast(`${v.name}: ${v.needs}`)
        })
      }
      // Working at the last look, idle now, asking nothing: it finished its turn. A turn a
      // scheduled wake-up started (woken after the person last typed) is routine, not news.
      const isWakeTurn = v.lastWakeMs !== undefined && v.lastWakeMs > (v.lastPromptMs ?? 0)
      if (!v.isSelf && !v.needs && !isWakeTurn && v.status === 'idle' && lastStatus.get(v.id) === 'busy') {
        alertOnce(`${v.id}:done:${v.lastEventMs}`, quietStart, () => {
          void $.ui.toast(`${v.name}: finished`)
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
        // With auto-compaction off the limit is the whole window: say so.
        const isAutoOff = selfLimit.isAuto === false
        const isNear = v.context >= v.limit * noteAt || v.verdict === 'over'
        const noteKey = `${v.id}:note:${v.compactions}`
        if (isNear && !alerted.has(noteKey)) {
          alerted.add(noteKey)
          // Once per compaction cycle, even across reloads of the mod.
          const sent = await $.state.get(NOTED).catch(() => ({ value: undefined }))
          if (sent.value !== noteKey) {
            await $.state.set(NOTED, noteKey).catch(() => undefined)
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
                        `Agent Task Hub: context is at ${formatTokens(v.context)} of the ${formatTokens(v.limit)} ${isAutoOff ? 'context limit' : 'auto-compaction point'}.${plan} ` +
                        'Before starting another large step, finish the current one and leave a short handoff note (what is done, what is left, key decisions), or suggest moving the rest to a new session.',
                    },
                  ],
                },
              })
              .catch(() => undefined)
            if (!isMuted) void $.ui.toast(
              `This chat's context is near ${isAutoOff ? 'its limit' : 'auto-compaction'} (${formatTokens(v.context)} of ${formatTokens(v.limit)})`,
            )
          }
        }
      }
    }
    // A conflict that has ended is forgotten: if it comes back, it is a new one.
    const conflictKey = (c: ConflictView) => `conflict:${c.path}:${c.sessions.join('|')}`
    if (hasWindow) {
      const current = new Set(conflicts.map(conflictKey))
      for (const key of alerted) if (key.startsWith('conflict:') && !current.has(key)) alerted.delete(key)
    }
    for (const c of conflicts) {
      alertOnce(conflictKey(c), quietStart, () => {
        void $.ui.toast(`Same file edited by ${nameList(c.sessions)}: ${c.path}`)
      })
    }
    if (hasWindow) {
      isFirstTick = false
      void translate($, foreign, now).catch(() => undefined)
      for (const v of views) lastStatus.set(v.id, v.status)
      // One line in the status bar, for when the pane is closed or the window narrow.
      const line = statusSummary(views)
      if (line !== lastStatusText) {
        lastStatusText = line
        $.ui.status(line)
      }
    }

    const project = root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? root
    await update($, hub, () => ({ project, updatedAt: now, sessions: views, conflicts, usage: usageWindows }))

    // AGENT_TASK_HUB_DEBUG=1: one line per refresh, for troubleshooting.
    if ((await $.env.get('AGENT_TASK_HUB_DEBUG')) === '1') {
      const took = (await $.clock.now()) - now
      const known = views.filter(v => v.context !== undefined).length
      const planned = views.filter(v => v.stepsTotal > 0).length
      $.ui.log(
        `agent-task-hub: refresh ${took} ms; ${views.length} chats, ${known} with context, ${planned} with a plan; ` +
          views.map(v => `${v.id.slice(0, 8)}=${formatTokens(v.context)}`).join(' '),
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, hub, h => ({ ...h, note: `Last refresh failed: ${message}` })).catch(() => undefined)
  } finally {
    isTicking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    startTimer($)
    // Nothing here holds up the chat's start: registering the command and opening
    // the pane run in the background.
    void $.command
      .register({
        name: 'task-hub',
        description: 'Open the Agent Task Hub pane: every chat in this project at a glance',
        argumentHint: '[auto on|off | quiet on|off]',
      })
      .catch(() => undefined)
    // No window to draw in (a headless run) is fine: /task-hub opens it later.
    void opensOnStart($).then(isOn => {
      if (isOn) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    })
    void tick($, true)
    return started
  })

  // ----- What this chat learns about itself, published in its beacon -----

  // End of a turn: the engine's own list of scheduled wake-ups and background work.
  // These hooks only observe: each returns at once and updates the status file in
  // the background, so a message or the end of a turn never waits on the mod.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    void changeOwn($, o => {
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
    }).catch(() => undefined)
    return result
  })

  // A permission dialog is about to ask the person: this chat now waits on them.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    const isDecided = (result as { decision?: unknown } | undefined)?.decision !== undefined
    if (!isDecided) {
      void changeOwn($, (o, now) => {
        o.permission = { tool: e.tool_name, since: now, agent: e.agent_id }
      }).catch(() => undefined)
    }
    return result
  })

  // The tool ran, failed or was refused: the dialog is gone. Only the agent that
  // raised it counts, so a subagent finishing a tool leaves the chat's own dialog be.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    void closeDialog($, e.agent_id).catch(() => undefined)
    return result
  })
  on('classic.PostToolUseFailure', async ($, e, next) => {
    const result = await next(e)
    void closeDialog($, e.agent_id).catch(() => undefined)
    return result
  })
  on('classic.PermissionDenied', async ($, e, next) => {
    const result = await next(e)
    void closeDialog($, e.agent_id).catch(() => undefined)
    return result
  })

  // A turn ended, also when the person said No or pressed Esc (no classic Stop then):
  // a dialog of that turn is gone.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void closeDialog($, e.agentId).catch(() => undefined)
    if (e.agentId === undefined) void keepTicking($).catch(() => undefined)
    return result
  })

  // A prompt: typed by the person (this chat is now in front of them), or a scheduled wake-up.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    // A run with no window (`claude -p`, a script) is nobody's chat in front of
    // them: it must not take over the toasts.
    void notePrompt($, e.source).catch(() => undefined)
    return result
  })

  // /task-hub opens the pane; /task-hub auto on|off says whether new chats open it themselves.
  on('command.run', { command: 'task-hub' }, async ($, e) => {
    const words = String(e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'quiet') {
      if (words[1] === 'on' || words[1] === 'off') {
        await $.store.set(QUIET_KEY, words[1] === 'on')
        return {
          text:
            words[1] === 'on'
              ? 'Agent Task Hub toasts are off. The pane still updates. Turn them back on with /task-hub quiet off.'
              : 'Agent Task Hub toasts are on again.',
        }
      }
      const isQuiet = (await $.store.get(QUIET_KEY).catch(() => undefined)) === true
      return { text: `Toasts are ${isQuiet ? 'off' : 'on'}. Change it with /task-hub quiet on or /task-hub quiet off.` }
    }
    if (words[0] === 'auto') {
      if (words[1] === 'on' || words[1] === 'off') {
        await $.store.set(AUTO_OPEN_KEY, words[1] === 'on')
        return {
          text:
            words[1] === 'on'
              ? 'New chats will open the Agent Task Hub pane on their own.'
              : 'New chats will no longer open the pane. Type /task-hub to open it.',
        }
      }
      const isOn = await opensOnStart($)
      return {
        text: `New chats ${isOn ? 'open' : 'do not open'} the pane on their own. Change it with /task-hub auto on or /task-hub auto off.`,
      }
    }
    if (words.length > 0) {
      return {
        text: 'Usage: /task-hub opens the pane. /task-hub auto on|off sets whether new chats open it. /task-hub quiet on|off mutes the toasts.',
      }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    void tick($, true)
    return { text: 'Agent Task Hub pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const state = await read($, hub)
    const isEarlierOpen = await read($, showEarlier)
    const now = await $.clock.now()
    lastDrawnAt = now
    // Shown again after being hidden (refreshed only every 30 s): catch up at once,
    // rather than show old data until the next 5-second refresh.
    // Data from a refresh without a window holds only this chat: refresh in full.
    const isStale = now - lastTickAt > TICK_MS + 1_000 || (isOwnOnly && now - lastTickAt > 1_000)
    if (state.updatedAt !== 0 && isStale) void tick($, true)

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
      `${state.sessions.length} ${state.sessions.length === 1 ? 'chat' : 'chats'}`,
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

    // Three states, three colours: waiting on you, working, idle.
    const statusOf = (v: SessionView) => {
      const isWaiting = v.needs !== undefined && !v.isSelf
      // This chat has a colour of its own (purple), apart from the others' blue Working.
      const markColor = isWaiting ? 'warning' : v.isSelf ? 'merged' : v.status === 'busy' ? 'suggestion' : 'subtle'
      const status = isWaiting
        ? { text: v.needs?.startsWith('Needs your approval') ? 'Needs approval' : 'Waiting for you', color: 'warning' }
        : v.isSelf
          ? { text: 'This chat', color: 'merged' }
          : v.status === 'busy'
          ? { text: 'Working', color: 'suggestion' }
          : {
              text: v.lastEventMs !== undefined ? `Idle ${formatAge(now - v.lastEventMs)}` : 'Idle',
              color: 'subtle',
            }
      return { isWaiting, markColor, status }
    }

    // The pane's width decides the layout: labelled rows when there is room, two lines
    // per chat when narrow, one line when very narrow. Nothing is cut off mid-word.
    const columns = Number((e.props as { bodyColumns?: number }).bodyColumns) || 80
    const layout = columns >= WIDE_COLUMNS ? 'wide' : columns >= TINY_COLUMNS ? 'compact' : 'tiny'

    const compact = (v: SessionView) => {
      const { markColor, status } = statusOf(v)
      const share = v.context !== undefined && v.limit ? v.context / v.limit : undefined
      const full = share !== undefined ? fullColor(share) : undefined
      const percent = share !== undefined ? `${Math.round(share * 100)}%` : undefined
      const step = Math.min(v.stepsDone + 1, v.stepsTotal)
      const plan =
        v.stepsTotal === 0 ? undefined : v.stepsDone === v.stepsTotal ? 'Done' : `Step ${step}/${v.stepsTotal}`
      // The rest, short, after the numbers: time left, a schedule, background work.
      const extras =
        [
          v.status === 'busy' && v.leftMs !== undefined && plan !== 'Done' ? `~${formatAge(v.leftMs)}` : '',
          v.scheduled !== undefined ? 'scheduled' : '',
          v.background.length > 0 ? `${v.background.length} in background` : '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      // What needs a look, in one line under the chat.
      const attention =
        v.needs?.startsWith('Needs your approval') && !v.isSelf
          ? `${v.needs.replace('Needs your approval: ', '')} is waiting for Allow`
          : v.quietMs !== undefined
            ? `No activity for ${formatAge(v.quietMs)}`
            : undefined
      if (layout === 'tiny') {
        return (
          <Box key={v.id} flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
              <Text color={markColor}>●</Text>
              <Text weight="semibold" wrap="truncate-end">
                {v.name}
              </Text>
            </Box>
            {percent && (
              <Box flexShrink={0}>
                <Text size="caption" tabular {...(full ? { color: full } : { dimColor: true })}>
                  {percent}
                </Text>
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box key={v.id} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
              <Text color={markColor}>●</Text>
              <Text weight="semibold" wrap="truncate-end">
                {v.name}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text size="caption" weight="medium" color={status.color}>
                {status.text}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1} paddingLeft={2}>
            {v.project && (
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">
                  {v.project}
                </Text>
              </Box>
            )}
            {plan && (
              <Box flexShrink={0}>
                <Text color={plan === 'Done' ? 'success' : undefined}>{plan}</Text>
              </Box>
            )}
            {percent && (
              <Box flexShrink={0}>
                <Text tabular {...(full ? { color: full } : {})}>
                  {percent}
                </Text>
              </Box>
            )}
            {extras && (
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">
                  {extras}
                </Text>
              </Box>
            )}
          </Box>
          {attention && (
            <Box paddingLeft={2}>
              <Text size="caption" color="warning" wrap="truncate-end">
                {attention}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    // This chat stands out as a whole: a purple frame around its block.
    const framed = (v: SessionView) => {
      const block = session(v)
      if (!v.isSelf || layout === 'tiny') return block
      return (
        <Box key={`self-${v.id}`} flexDirection="column" borderStyle="round" borderColor="merged" paddingX={1}>
          {block}
        </Box>
      )
    }

    const session = (v: SessionView) => {
      if (layout !== 'wide') return compact(v)
      const { markColor, status } = statusOf(v)

      const isDone = v.stepsTotal > 0 && v.stepsDone === v.stepsTotal
      // Time left only while it works: an idle chat's plan waits on the person.
      const left = v.status === 'busy' && v.leftMs !== undefined ? ` · ~${formatAge(v.leftMs)} left` : ''
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
            valueText={`Step ${step} of ${v.stepsTotal}${left}`}
          />
        ) : (
          <Text wrap="truncate-end">
            Step {step} of {v.stepsTotal}{left} · {v.currentStep ?? 'In progress'}
          </Text>
        )

      const verdict = verdictLabel(v)
      const share = v.context !== undefined && v.limit ? v.context / v.limit : undefined
      const percent = share !== undefined ? ` (${Math.round(share * 100)}%)` : ''
      // Yellow from 80% of the limit, red from 95%: a full chat stands out, plan or no plan.
      const full = share !== undefined ? fullColor(share) : undefined
      const context =
        v.context === undefined ? undefined : (
          <Box flexDirection="row" gap={1}>
            <Text tabular {...(full ? { color: full } : {})}>
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
                  {v.background.join(', ')}
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
          <Text size="caption" dimColor tabular wrap="truncate-end">
            {summary}
          </Text>
          {(state.usage ?? []).length > 0 && (
            <Box flexDirection="row" gap={1}>
              <Text size="caption" dimColor>
                Usage
              </Text>
              {(state.usage ?? []).map(u => (
                <Text key={u.kind} size="caption" tabular {...(fullColor(u.percent / 100) ? { color: fullColor(u.percent / 100) } : { dimColor: true })}>
                  {`${Math.round(u.percent)}% of ${usageName(u.kind)}`}
                </Text>
              ))}
            </Box>
          )}
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

        <Box flexDirection="column" gap={layout === 'wide' ? 2 : 1}>
          {recent.map(framed)}
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
            {isEarlierOpen && earlier.map(framed)}
          </Box>
        )}
      </Box>
    )
  })
}
