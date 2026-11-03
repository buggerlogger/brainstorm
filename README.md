# brainstorm

A context debugger for Claude Code sessions, as a desktop app. Open a session,
watch every API call it makes land in the debugger frame by frame, edit any of
the context, and **Save & Resume** — claude restarts on the edited session in
the same terminal window, and you keep working.

```
dist\brainstorm.exe                  the app (one file, no install)
node bin/app.mjs                     the same, from source
node bin/brainstorm.mjs flow ...     the context flow on the command line
node bin/brainstorm.mjs build ...    the engine, unchanged
```

## The loop

1. **Start.** The app opens blurred, asking for a session. Type an id, an id
   prefix, a folder, or words from the first prompt — matches rank in that
   order. Recent sessions come first.
2. **Run.** Leave *open a terminal* ticked and a real terminal window opens in
   the session's folder running `claude --resume <id>`, with a genuine TTY.
3. **Watch.** Each API call claude makes is a *jump*. With **follow** on, the
   debugger steps through every frame that call added, one at a time, and each
   frame shows **who read it**: which agents had that text in context, on
   which calls.
4. **Edit.** Change any block, drop it, or pin text that must survive a rewind.
5. **Save & Resume** (`Ctrl+Shift+S`). Build, verify, install a new session —
   then claude is restarted on it *in the same window*.

Step 5 is a loop inside the window, not a new window. The terminal runs a
small runner that reads a control file; Save & Resume writes the new session id
and ends only the claude that runner started (by the pid it recorded, never by
searching command lines). The runner sees claude exit and resumes the new id.
No dead tab, no lost scrollback, no second window. Measured: two consecutive
Save & Resumes, runner pid unchanged, `--resume N1` then `--resume N2`, the
second session carrying both edits.

## Right-click

| on | you can |
|---|---|
| a block | open · where does it load? · **who read it?** · **search in strings** · copy · pin a copy · drop/restore · rewind to here · **export its folder (folder or ZIP)** |
| a folder | expand · search · **dump to files** · **export as ZIP** |
| a frame | open · who read it? · breakpoint (`F9`) · run to next breakpoint · copy · where else does it load? |
| a session | open · open + terminal · show in Explorer · copy id / path |
| editor selection | search in strings · where does it load? · who read it? · pin it |
| anywhere else | open session (`Ctrl+O`) · strings (`Ctrl+Shift+F`) · **dump whole context** · **export ZIP** · Save & Resume · settings |

**Search in strings** is the x64dbg view: every occurrence across editable
blocks, the main agent's frames and every subagent's, with the match
highlighted. Click a row to jump straight to it.

**Export** writes a tree that sorts the way it reads — numbered folders, files
named by block id and transcript line — plus `README.txt`, `CONFIG.json`,
`BLOCKS.md` (so an export can be re-imported), the context flow, and each
subagent. A folder or a ZIP; same tree either way.

File *names* in exports are ASCII; file *contents* keep every character.
Measured: a spec-correct archive (bit 11 set, valid UTF-8) with an Arabic file
name is read exactly by .NET's ZipFile, and Windows' own `tar.exe` **skips** it
with "unreadable filename", even when told the charset. A reader that silently
drops a file is data loss, so names are folded to ASCII (accents to their base
letter, the rest to `_`).

## Agents

A session is not one context. Every Agent call starts a subagent with its own
transcript under `<session>/subagents/`, with a `meta.json` naming the parent
tool call. A **fork** also inherits the parent conversation up to a recorded
uuid, so text the fork never saw in its own file *was* still in its context.
"Who read it" accounts for that: those readers are marked *inherited*. Click
any agent to step through its own flow.

## The app

`brainstorm.exe` is Node's single-executable format: the server, the engine and
the UI are inside one 89 MB file. It opens an Edge app window — chromeless,
its own taskbar entry — with a **separate profile** under
`%APPDATA%\brainstorm`, so nothing from your own browser (cookies, history,
extensions) is read or used. Closing the window closes the app: the window
sends a heartbeat, and the server exits when it stops. A second launch finds
the running app and opens another window onto it.

Inside the exe the engine is the exe itself, re-invoked as
`brainstorm.exe --engine <verb>` — there is no `ctx.mjs` on disk to hand to
Node. Every path that used to come from `import.meta.url` goes through
`src/runtime.mjs`, the one place that knows which mode it is in.

```
node scripts/build-exe.mjs           -> dist\brainstorm.exe
```

Unsigned: SmartScreen may warn on first run. That is a missing code-signing
certificate, not a defect.

## Settings

Everything is in the ⚙ view and `%APPDATA%\brainstorm\settings.json`: the
shell, whether a terminal opens on load, the claude executable and extra
arguments, Save & Resume behaviour, follow delay and which frames to follow,
auto-attach, export folder and contents, theme, font size, wrap, poll rates.
The settings form is rendered from the same schema that validates what is
saved, so an option cannot exist in one and not the other.

## Why

A Claude Code transcript is not a conversation. It is a conversation plus
bookkeeping, and the same text is stored in several places at once. Editing the
message you can see leaves copies in the places you cannot, and some of those
copies re-enter context on resume.

This tool was built by finding those places and measuring them, not by
reasoning about them.

## What it does

**Explorer.** The open session's blocks in folders, over every project and
session on the machine. A `user` record is not always a person talking, so
content classes get folders of their own — measured on one 15,045-line session,
the user role carried 7 task notifications, 22 local-command results, 11 slash
commands and 28 pastes, which filed together bury the turns you actually wrote:

```
User messages        166   284.3K ch
Assistant messages   995   453.8K ch
Task notifications     6     7.9K ch
Slash commands        33     5.1K ch
Tool calls          1571  2236.6K ch
Tool results        1570  1678.9K ch
Thinking             978
```

Matching is anchored to the start of the text, never a loose `includes`: a
paste quoted inside a reply must not reclassify the reply.

**Editor.** Click a block, edit it, `Ctrl+S`. Drop a block from the context
entirely with the eye icon. The status bar carries the running cost: kept
blocks, characters, estimated tokens, and the chars-per-token ratio — labelled
`measured` or `ESTIMATE`, with the reason it could not be measured.

**Context debugger.** Trace a session and step frame by frame through
everything the model was given, in order: each system prompt block, each tool
definition, each message and each content part, with its size, its estimated
tokens, its cache breakpoint and the transcript line it came from. Right-click
a frame for a breakpoint, `F10` to step, `F5` to run to the next one.

**Find in context.** Type any text and get every frame it enters context in,
in flow order. `Enter` jumps to the next one until the flow is finished. This
answers the question the tool exists for: *where does this actually load?*

**Terminal.** A real shell — PowerShell or cmd on Windows, bash elsewhere —
running whatever you type. Engine verbs (`status`, `build`, `verify`) are
intercepted and run the *bundled* engine, so the terminal and the UI can never
drift onto two implementations.

It is pipes, not a pseudo-terminal, so a full-screen TUI will not render
there. `claude -p "..."` works perfectly.

**Open terminal ↗** is the answer to the rest: it pops a *real* terminal
window on your desktop, in the project's directory, with a genuine TTY — run
interactive `claude` in it yourself. This is the x64dbg shape: the debugger
does not try to be the program, it attaches to one that is already running.

How that launch was chosen, measured on Windows 11 with Windows Terminal set
as the default terminal application. The probe made the new window write its
own console state to a file:

| strategy | result |
|---|---|
| `wt.exe -w new -d <cwd> powershell -NoExit -File <script>` | **ok** — `inRedir=False outRedir=False` |
| spawn with `stdio: 'inherit'` | ran, but `inRedir=True` — not typable |
| spawn with `detached: true` | **failed** — argv dropped entirely |
| `cmd /c start "t" /D <cwd> powershell …` | **failed**, detached or not |
| `conhost.exe powershell …` | **failed** |

Two obvious things are wrong here. `detached: true` — the documented way to
give a child its own console — loses the command line: those processes appear
in `Win32_Process` as a bare `"powershell.exe"` with no arguments. And `start`
never ran its command either. Both are consequences of the default-terminal
handoff. Only `wt.exe` produced a window with input *and* output unredirected,
which is what interactive actually means. The `start` path is kept for machines
with no Windows Terminal, and is marked untested rather than claimed to work.

A command to pre-run goes into a script file, never onto a command line:
quoting it through cmd and PowerShell and wt is three chances to corrupt it,
and an earlier version "escaped" it by *stripping* double quotes, which
silently changed what the window ran.

**Attach.** Sessions in the project, newest first, live ones marked — a process
list. Attach to read and edit the context of a session while it runs, or turn
on auto-attach (skipped while you have unsaved edits, because switching the
editor out from under someone loses work).

**Live.** Start a Claude session anywhere — this terminal, your own Windows
Terminal, an editor extension — and its context is debugged as it runs:

| event | means |
|---|---|
| `session` | a new transcript appeared |
| `jump` | an API call went to the model, with frames, system/tools/conversation split and token estimate |
| `call` | a tool invocation entered the transcript |

Detection watches the project's transcript *directory*, not a process, so it
needs no wrapper, no flag and no cooperation from the CLI, and it survives the
shell being restarted. Click any event to attach the IDE to that session and
jump to the exact frame.

**Resizable panes.** Drag the splitter beside the sidebar or above the panel;
double-click either to restore the default. Sizes persist per browser.

**Build.** Writes `BLOCKS.md`, runs the engine, and reports what changed: blocks
edited, mirrors synced, tool mirrors synced, renames applied, residue left, and
a frame-level diff of what your edit did to the context.

**Resume.** Send a message into the rebuilt session from inside the tool and
re-trace, so you can see the effect of an edit on the next turn.

## How the flow is reconstructed

Claude Code records the request it actually sent:

| record | holds |
|---|---|
| `api-request-shape` | `system[]` and `tools[]` |
| `api-request-blob` | one message, by content hash |
| `api-request` | `shapeHash`, `keep`, `tail[]`, `cacheControl[]` |

So the message list for call *N* is:

```
messages(N) = messages(N-1).slice(0, keep) ++ tail.map(resolve)
```

That model is not assumed. `cacheControl` addresses messages by index, so the
list must be at least `maxIndex + 1` long — and if the model is right, exactly
that. **Measured over 3,566 API calls in 41 transcripts: 3,566 tight, 0 short.**
An accumulating model (`prev ++ tail`) is never tight, so it is wrong.

Hashes resolve to a stored blob where one exists, otherwise positionally
against the message chain. Each hash resolves **once** and is reused: a repeated
hash is the same message re-sent. Before that fix the resolver consumed two
chain messages for one and starved, producing 21,286 unresolved frames; after
it, 3.

### When the records are absent

**Only 39 of 189 transcripts on the machine this was built on record any of
it.** Every `cli` entrypoint session has none. There the flow is
**reconstructed** from the message chain, `mode` says so, and the system prompt
and tool definitions are reported as unknown rather than invented — on a
comparable session those were 10,400 and 41,761 characters, so pretending the
total is complete would understate the window by ~52K characters.

## Install

Use `dist\brainstorm.exe` — nothing to install. Or from source:

```
git clone <this repo>
cd brainstorm
node bin/app.mjs                 # the app window
node bin/brainstorm.mjs ide      # the server alone, in your own browser
```

No runtime dependencies. Node 22+ from source (the zip writer uses
`zlib.crc32`); building the exe needs Node 24 and fetches esbuild and postject
through npx at pinned versions.

## Tests

```
node test/run.mjs              syntax + flow model      (fast)
node test/run.mjs --all        also the HTTP API and a real end-to-end swap
node test/sweep.mjs            the flow model over every transcript on the box
node test/run.mjs --exe        also build brainstorm.exe and test it end to end
```

`--all` includes `ui-e2e.test.mjs`, which drives the real UI in headless Edge
over the DevTools protocol (throwaway profile) and fails on any uncaught
exception or console error — the class of bug no static check sees — and
`save-resume.test.mjs`, which runs the whole Save & Resume loop twice against a
stub claude and checks the window was never replaced.

`test/shell.test.mjs` runs `claude -p` **through the IDE's own shell** and
asserts the watcher reported a jump with a real context size — the claim that
would otherwise be easiest to fake.

`test/skillswap.test.mjs` is the end-to-end proof: it writes two skills with
different secrets, runs a real session that loads one, swaps it for the other
in the transcript, rebuilds, resumes, and asks for facts that exist **only**
inside the replaced skill body. A skill is used deliberately — one invocation
scatters its identity across six places, which is the hardest thing in a
transcript to edit completely.

## Layout

```
bin/brainstorm.mjs      CLI: ide, flow, and engine passthrough
src/ctx.mjs             the engine: extract, build, verify, install
src/core/transcript.mjs reading records, chain messages
src/core/flow.mjs       the flow reconstruction and the probe
src/core/blocksmd.mjs   BLOCKS.md parse/serialise, folder grouping
src/core/sessions.mjs   finding sessions; refuses ambiguous ids
src/core/pins.mjs       sticky context that survives a rewind
src/core/watch.mjs      session detection; jumps and calls, live
src/server/ide.mjs      the HTTP API (loopback only)
src/server/shell.mjs    the real shell behind the terminal
src/server/console.mjs  popping a real terminal window on the desktop
src/server/session-window.mjs  the window claude runs in; resume in place
src/runtime.mjs         source vs packaged exe: assets, engine, app data
src/core/agents.mjs     subagents, forks, who read what
src/core/search.mjs     the start gate's session search; search for strings
src/core/export.mjs     dump to sorted folders; zip.mjs writes the archive
src/core/settings.mjs   the settings schema
bin/app.mjs             the exe's entry: app window, or --engine
scripts/build-exe.mjs   single-executable build
ui/gate.js menu.js follow.js panels.js   start gate, right-click, follow, panels
ui/                     the editor: index.html, app.js, styles.css
test/                   run.mjs, flow.test.mjs, ui.test.mjs, api.test.mjs,
                        shell.test.mjs, skillswap.test.mjs, sweep.mjs
```

The server never writes a `.jsonl`. It writes `BLOCKS.md` and shells out to the
engine, which re-reads its own artefact and verifies it. The UI can be wrong
about text; it cannot invent a new way to corrupt a session.
