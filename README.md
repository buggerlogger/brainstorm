# brainstorm

A context IDE for Claude Code sessions. Browse a transcript as folders and
blocks, edit any of it, step through what actually enters the model's context,
rebuild the session and resume it with your changes.

![layout](docs/layout.md)

```
brainstorm ide                      open the editor on http://127.0.0.1:7788
brainstorm flow --session <id>      print the context flow for each API call
brainstorm list | extract | build   the engine, unchanged
```

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

```
git clone <this repo>
cd brainstorm
node bin/brainstorm.mjs ide
```

No dependencies. Node 18+.

## Tests

```
node test/run.mjs              syntax + flow model      (fast)
node test/run.mjs --all        also the HTTP API and a real end-to-end swap
node test/sweep.mjs            the flow model over every transcript on the box
node test/shell.test.mjs       the terminal, and live detection of a real session
node test/console.test.mjs --open   pops a window and proves it is a real TTY
```

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
ui/                     the editor: index.html, app.js, styles.css
test/                   run.mjs, flow.test.mjs, ui.test.mjs, api.test.mjs,
                        shell.test.mjs, skillswap.test.mjs, sweep.mjs
```

The server never writes a `.jsonl`. It writes `BLOCKS.md` and shells out to the
engine, which re-reads its own artefact and verifies it. The UI can be wrong
about text; it cannot invent a new way to corrupt a session.
