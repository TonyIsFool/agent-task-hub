# Changelog

All notable changes to the public releases of Agent Task Hub.

## 0.2.3 (2026-11-29)

- The website confirms its ownership to Google Search Console, so it can be found in search.

## 0.2.2 (2026-11-29)

- A website: https://tonyisfool.github.io/agent-task-hub/ , with install steps, a
  comparison with other ways to follow several chats, and common questions.
- The README opens with the problem it solves, compares Agent Task Hub with other ways,
  and answers the questions people ask ("How do I see all my Claude Code sessions at
  once?").
- One README section lists everything the mod reads, writes, runs and sends.
- The plugin has a display name, `Agent Task Hub`.

## 0.2.1 (2026-11-27)

- `/task-hub auto off` and `/task-hub auto on` choose whether new chats open the pane on
  their own. This replaces the `openOnStart` setting, which could not be changed in the
  desktop app and made the install ask about an option that already had a default.
- Lighter on the disk: status files of chats that have stopped are skipped without being
  opened, each chat rewrites its own file only when something changes (and every 30 s as
  a heartbeat), and the process list is checked only for chats without a fresh file.
- Opening the pane and registering `/task-hub` no longer hold up the start of a chat.
- Faster: sending a message or ending a turn no longer waits on the mod (about 1.5 s
  less each time); on first load each chat's newest part is read first, so every chat
  shows its current state within one refresh instead of after up to 15 seconds.
- Transcripts over 4 MB are read on Claude Code versions that refuse a text read of a
  file that large.
- `AGENT_TASK_HUB_DEBUG=1` logs one line per refresh, and `AGENT_TASK_HUB_NOTE_AT`
  lowers the near-compaction threshold, for troubleshooting.
- A long-open pane forgets chats that ended over 10 minutes ago, and the store keeps
  only the 500 most recently used English titles.
- Lighter while open: every chat is read at the same time, where-am-I lookups happen once a
  minute, and a pane nobody sees refreshes every 30 seconds instead of every 5.
- The README explains the terminal: below 144 columns the pane waits for `/task-hub`.
- After `/clear` the chat shows once, as the new chat: before, for up to a minute it
  showed twice and kept the old chat's schedule and last prompt.
- **Needs approval** clears when you answer No or press Esc (those end the turn with no
  Stop hook); a subagent finishing its own tool no longer clears the chat's dialog.
- A chat waiting on your approval is never flagged as stuck.
- A refresh that keeps failing no longer sets off another one on every redraw.
- Status files of chats gone for a week are deleted once a day, so the folder does not
  grow with every chat ever opened.
- Context use turns yellow from 80% of the limit and red from 95%, so a nearly full chat
  stands out even with no plan running.
- A new message ends a question asked before it: a chat no longer shows **Has a question**
  for one that was never answered.
- A run with no window (`claude -p`, a script, a chat not on screen) reads only its own
  chat and asks for no titles; the full refresh comes when a window draws the pane, and
  what was already waiting is not announced all at once.
- With auto-compaction off, the reminder speaks of the context limit.
- A chat forgotten from memory forgets its alerts too, and ended conflicts are dropped.
- A fork no longer sets off a "same file" warning for every file its parent edited: the
  history copied into it still names the parent on each line, and those edits are left
  out. Chats are now told apart by id, so two chats of one name editing one file count
  as two, and a toast with three names reads `A, B and C`.
- The near-compaction reminder is remembered in the session's state, so
  `/reload-plugins` no longer sends it again.
- A narrow pane keeps up: below 48 columns each chat takes two lines without labels,
  below 28 one line, so nothing is cut off when the pane is dragged narrow.
- A working chat that finishes a turn you started is announced (`Eye kit: finished`); a
  turn its schedule woke is not.
- This chat is marked in purple and framed, so it stands out from the other chats.
- `/task-hub quiet on` mutes the toasts; `/task-hub quiet off` brings them back.
- The compact layout also shows time left, a schedule and background work.
- The status line sums up the other chats (`Task hub: 1 waiting · 2 working`).
- The header shows the account's usage windows (`Usage 42% of 5h 12% of week`).
- A working plan shows the time it likely needs (`Step 3 of 5 · ~12m left`), from the
  recent steps with pauses left out.
- Background work is listed by name instead of a count.
- One word throughout: the header counts chats (`4 chats`), not sessions. Connector
  tools read as `navigate (Claude Browser)` instead of `mcp__Claude_Browser__navigate`.

## 0.2.0 (2026-11-25)

**First public release.**

- One pane beside the chat for every live Claude Code chat under the project root:
  status, project folder, plan progress with the step in hand, context use, background
  work and long-running commands.
- Context forecast: whether the rest of a plan fits before auto-compaction, and a short
  note to the chat itself when it gets close.
- Each chat publishes a small status file of its own, so the pane shows scheduled work
  (`/loop`, scheduled wake-ups) with the next run, open permission dialogs, and exact
  context limits for every chat.
- Warnings when two chats edit the same project file, when a chat waits for you, and
  when a working chat goes quiet with nothing running.
- Toasts come only from the chat you typed in last, so each appears once.
- Chats idle for over an hour fold into one line; chats whose process is gone are left out.
- Chat names appear as the sidebar shows them; everything else is English.
- Setting `openOnStart` (replaced in 0.2.1 by `/task-hub auto`).
