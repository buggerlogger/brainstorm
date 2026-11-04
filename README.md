<h3 align="center">See exactly what Claude Code sends to the model. Edit it. Resume.</h3>
<p align="center"><br/>
<h1 align="center"><img src="assets/banner.png" width="600" alt="brainstorm"></h1>

<p align="center">
  <a href="https://github.com/buggerlogger/brainstorm/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/buggerlogger/brainstorm?style=flat-square"></a>
  <a href="https://github.com/buggerlogger/brainstorm/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/buggerlogger/brainstorm/total?style=flat-square"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/buggerlogger/brainstorm?style=flat-square"></a>
  <img alt="platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square">
  <a href="#only-the-live-view-in-any-claude"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square&logo=claude&logoColor=white"></a>
  <a href="#install"><img alt="node >= 22" src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="https://github.com/buggerlogger/brainstorm/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22"><img alt="good first issues" src="https://img.shields.io/github/issues/buggerlogger/brainstorm/good%20first%20issue?style=flat-square&label=good%20first%20issues&color=7057ff"></a>
  <a href="https://github.com/buggerlogger/brainstorm/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/buggerlogger/brainstorm?style=flat-square"></a>
  <a href="https://github.com/buggerlogger/brainstorm/commits/master"><img alt="last commit" src="https://img.shields.io/github/last-commit/buggerlogger/brainstorm?style=flat-square"></a>
  <a href="#status"><img alt="status: beta" src="https://img.shields.io/badge/status-beta-orange?style=flat-square"></a>
</p>
<p align="center"><br/>
<code>npx github:buggerlogger/brainstorm setup</code>


**See exactly what Claude Code sends to the model. Edit it. Resume.**

brainstorm is a context debugger and editor for Claude Code. Open any session
and see every block of its context as claude is sent it; watch each request
live (waiting for the API, thinking, writing, tool calls, the prompt cache);
change, drop or pin anything; then **Save & Resume**: claude restarts on the
edited session in the same terminal, and you keep working.

**[Download brainstorm.exe](https://github.com/buggerlogger/brainstorm/releases/latest)**
-- Windows, one file, nothing to install. **Beta**: it works end to end and is
tested against a real claude, but it is still changing.

Or everything in one command (Node 22+): the latest code, the live plugin in
Claude Code, and the app built into `Desktop\brainstorm-app`:

<code>npx github:buggerlogger/brainstorm setup</code>

Run it again to update. Node older than 24 cannot build the exe, so it takes
the latest release instead, checked against the digest GitHub publishes.
`--download` does that on purpose; `--no-plugin` leaves Claude Code alone;
`--to <folder>` puts the app somewhere else.

<!-- demo GIF goes here -->

## Features

- **Context editor**: every block of the context, grouped; edit, drop or pin it.
- **Main context**: facts that survive every rewind, put back into the first
  message claude is sent on every build.
- **Live, from inside claude**: each request as it streams, each tool call
  before it runs, the cache read / written / new, and every `/compact`.
- **Recording**: the calls claude makes from now on; every block has a pen that
  opens it in the editor.
- **Save & Resume**: build, verify, install, and restart claude in the same
  window. The build refuses what the API would refuse.
- **Agents**: subagents and forks, and who read what.
- **A guide for the first time**: everything blurred but the one button to
  click, step by step, from a new session to claude answering with your edit.

## Only the live view, in any claude

The live hooks are a Claude Code plugin of their own. Installed, any claude
session streams into the brainstorm app while it runs:

```
/plugin install brainstorm-live --marketplace buggerlogger/brainstorm
```

## Example: bug hunting with a context template

<img width="1280" height="719" alt="image" src="https://github.com/user-attachments/assets/da7c68c3-c024-488d-a824-a6a5553591af" />


[CONTEXT TEMPLATE I USED IN SS](context-template/bugbountyhuntingcontext.md)

## Run it

```
dist\brainstorm.exe                  the app (one file, no install)
node bin/app.mjs                     the same, from source
npm run setup                        pull, install the plugin, build into Desktop\brainstorm-app
node bin/brainstorm.mjs flow ...     the context flow on the command line
node bin/brainstorm.mjs build ...    the engine, unchanged
```

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## The loop

1. **Start.** The app opens blurred, asking for a session. Type an id, an id
   prefix, a folder, or words from the first prompt — matches rank in that
   order. Recent sessions come first. **Create session** starts a new claude
   in a folder you pick and opens its session as soon as claude saves it;
   **Reload list** reads the sessions again. On the very first start a
   **guide** walks you through a first edit, one highlighted button at a time
   (the **Guide** button in the title bar opens it again, with guides for
   after a `/compact` and for making claude forget a rule).
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

## Live: from inside claude

The transcript gets a block only when the block is complete, so a minute of
thinking used to be a minute of nothing. Every claude a session window starts
now loads **`mod/brainstorm-live`** with `--plugin-dir`: a Claude Code mod
whose hooks sit in the engine itself and post each event to brainstorm as it
happens. The **Live** panel (Recording view) draws the request in flight:

| phase | what it is |
|---|---|
| waiting for the API | sent, nothing back yet; the usage later says how much came from the prompt cache and how much was new |
| thinking | thinking chunks are arriving, with the last sign of life |
| writing | text, or a tool call's arguments, streaming |

Each tool call appears with its arguments **before it runs** (`tool.call`),
then what came back; clicking it opens both, and once the transcript has the
call it jumps to that recorded block (same `tool_use_id`). Measured through
the mod on a real `claude -p`: 16 messages sent, 6.7 s before the first
chunk, `Read note.txt` 482 ms, the next request 43 ms after the tool returned
with 41,137 tokens read from the cache.

What no hook can show: the **words** of the thinking. Claude Code asks the API
for `"display": "omitted"` (measured on the wire), so thinking chunks arrive
empty — they still arrive about once a second while it thinks, which is how
the panel knows it is thinking and not stalled.

The mod never changes anything: each chunk is passed on at once and every
tool call goes on; events are posted without waiting, so a closed brainstorm
cannot slow claude down. It finds brainstorm through `live.json` in the app
data folder, read again when a post fails, so a claude left running finds the
next brainstorm you open. Turn it off with **Live hooks** in Settings.

## Editing from the debugger, and the main context

Recording is the debugger (the separate debugger view is gone). Every block of
every call in it has a **✎**: it opens the block that frame came from, by its
transcript line. A frame
rebuilt from the request records is matched to its message by kind and exact
text; when that text is in several messages the pen is off rather than
guessing. A call recorded after the session was opened has no block yet, so
its pen offers to refresh the blocks from the transcript, carrying your edits
over by line (an edit whose message was rewound or compacted away in claude is
reported, not silently dropped).

Saving an edited **message** warns first, over a blurred app: rewinding the
chat to before that message deletes it, and the edit with it. *Move my text
to the main context* moves only the lines you added and puts the message back.

The **main context** (◆ at the top of the tree) is one pin per project, in the
first user message: stored outside the transcript and put back on every build
and after every rewind, so a rewind cannot delete it. A compaction can: Claude
rewrites the conversation into a summary, so once the session has compacted
since you saved it, the main context is paused instead of re-inserted word for
word. Saving it again pins it again.

## What build will not write

Measured against the real API, on a compacted session whose summary was
cleared -- exactly what broke a real session:

| the summary block | the API |
|---|---|
| emptied | `400 messages.0: user messages must have non-empty content` |
| left as whitespace | `400 text content blocks must contain non-whitespace text` |
| dropped | accepted, and the fact it held was gone |

So **clearing a block drops it**, a dropped tool call takes its result with it,
an empty message already in a session is repaired (removed, the chain
re-linked) on the next build, and `verify` refuses one written by hand. The
build prints each of these. Opening a session an earlier build left broken and
doing Save & Resume heals it.

**Not sent.** A rewind leaves the branch it left in the file, and a compaction
leaves everything before its boundary; claude never sends either again. Those
blocks are filed under *Not sent (rewound or compacted away)*, shown dim, and
left out of the context size: editing them changes nothing. On one real
session that was 37 of 360 blocks.

**Memory files are not the context.** Claude Code can save a fact to the
project's memory folder. Editing the conversation does not change that file,
and claude will notice the two disagree -- measured: it answered that "the
saved memory file now says" the old value.

`test/real-flow.test.mjs` runs the whole loop with a real claude in a new
folder, twice: a small task, the fact edited and a message cleared, Save &
Resume, claude asked without tools (it answers with the edit), a new task, then
a tool call dropped and a main context set, and claude asked again.

## How to edit the context: the flow that works

Measured with a real claude, compacted twice (`test/real-compact.test.mjs`):

1. **Let claude finish.** Edit between turns, not while a request is in flight
   (the Live panel says which).
2. **Refresh if the tree says so.** After a rewind or a `/compact` in claude the
   tree shows ⟳ at the top. A compaction's new summary is no block until then.
   Save & Resume refreshes by itself, but you cannot edit what is not there.
3. **Edit what is sent.** Blocks under *Not sent* are on a rewound branch or
   before a compaction: editing them changes nothing. In a compacted session
   the conversation starts at the **summary**: that is the block to edit.
4. **Put lasting facts in the main context (◆), not in a message.** A message
   is lost when the chat is rewound before it; the main context is put back on
   every build and after every rewind, into the first message claude is sent.
5. **To remove something, drop it (◉) or clear it.** Clearing drops it; the
   build never writes an empty message (the API refuses one).
6. **Save & Resume.** The terminal restarts claude on the edited session.
7. **Check by asking without tools**: "Without using any tools, what does this
   conversation say about X?" -- a tool would read the files on disk instead.

After a `/compact` the main context is **paused** if it was saved before the
compaction (the summary now carries it); save it again to pin it again. After
Save & Resume a compacted session looks almost empty and shows `Ctx: 0`: that
is what a compacted conversation is -- the summary -- and the context size
appears with the first request.

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
extensions) is read or used. A second launch finds the running app and opens
another window onto it.

**There is no console window.** The exe is a console-subsystem binary, so a
double-click used to open a black log window beside the app — and closing that
window killed the server under the app. The visible launcher now starts a copy
of itself with no console and exits in ~60 ms; the copy logs to
`%APPDATA%rainstormpp.log`. `--console` keeps the old behaviour.

**The app lives as long as a window is open — including one in the
background.** Presence used to be a timer heartbeat, and Edge throttles a
background window's timers to about once a *minute* after five minutes, so
the server took the silence for a closed window and exited under it (found
from a real report: a window open 6 minutes, nothing listening on its port).
Presence is now a held-open connection: a closed window drops it at once, a
background window keeps it. Measured: 35 s of total silence from an open
window, server still up; window closed, server gone 10–12 s later. The window
is also launched with the switches that stop Edge throttling it, so follow
mode keeps stepping while you work in the terminal — and the profile folder is
named after those switches, because Edge runs one process per profile and a
window from an older build would otherwise swallow the new launch with its
old, throttled flags.

If the server is ever gone anyway, the window says so in a red banner, and the
start screen says "the brainstorm server is not running" instead of looking
like your session does not exist.

Rebuilding never needs the app closed: a running exe is locked against
deletion but not against renaming, so the build moves it aside and writes the
new one in its place.

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

`test/live-mod.test.mjs` runs a real `claude -p` with the mod and checks that
everything the Live panel draws reached brainstorm from inside the engine.

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
src/core/pins.mjs       sticky context that survives a rewind; the main context
src/core/watch.mjs      session detection; jumps and calls, live
src/core/recorder.mjs   the Recording view's calls, read from the transcript
src/core/live.mjs       the brainstorm-live mod's events, one record per request
mod/brainstorm-live/    the Claude Code mod: hooks inside claude (--plugin-dir)
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
ui/gate.js menu.js recording.js live.js panels.js
                        start gate, right-click, recording, live, panels
ui/                     the editor: index.html, app.js, styles.css
test/                   run.mjs, flow.test.mjs, ui.test.mjs, api.test.mjs,
                        shell.test.mjs, skillswap.test.mjs, sweep.mjs
```

The server never writes a `.jsonl`. It writes `BLOCKS.md` and shells out to the
engine, which re-reads its own artefact and verifies it. The UI can be wrong
about text; it cannot invent a new way to corrupt a session.

## Status

**Beta.** brainstorm works end to end, and each release is tested against a
real claude, but interfaces, file formats and behaviour can still change.
Releases: <https://github.com/buggerlogger/brainstorm/releases>.

## Contributors

<a href="https://github.com/buggerlogger/brainstorm/graphs/contributors"><img src="https://contrib.rocks/image?repo=buggerlogger/brainstorm" alt="contributors"></a>

- [bfs2021](https://github.com/bfs2021): exports follow `BRAINSTORM_HOME`, so a
  test run no longer leaves a zip on the Desktop
  ([#5](https://github.com/buggerlogger/brainstorm/pull/5))

Want to be on this list? Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[good first issues](https://github.com/buggerlogger/brainstorm/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

brainstorm is open source under the [Apache License 2.0](LICENSE).

You are free to use it — personally or commercially — and to fork it, modify
it, and include it in your own projects. Contributions are welcome.

## Credit

brainstorm was created by **[buggerlogger](https://github.com/buggerlogger)**.
Copyright 2026 buggerlogger.

If you redistribute brainstorm or anything built from it — a fork, a copy in
another repository, or code included in your own project — the license
requires you to (Apache-2.0, Section 4):

1. **keep the [NOTICE](NOTICE) file**, which credits the original author and
   links this repository;
2. **keep the copyright and license header** at the top of every source file;
3. **mark the files you changed**, so your changes are not presented as the
   original, and the original is not presented as yours;
4. include a copy of the [LICENSE](LICENSE).

The license does not let anyone use the name *brainstorm* or the author's name
to suggest that a copy is the original or is endorsed by its author
(Section 6). A fork is welcome; republishing this work with the credit removed
is not permitted.

A one-line credit in your own README is appreciated:

```
Based on brainstorm by buggerlogger — https://github.com/buggerlogger/brainstorm
```

