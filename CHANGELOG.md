# Changelog

All notable changes to the public releases of Agent Task Hub.

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
- Setting `openOnStart`.
