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

**Explorer.** The open session's blocks, grouped into folders by role and kind
(User messages, Assistant messages, Tool calls, Tool results, Thinking), over
every project and session on the machine.

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

**Terminal.** Runs the engine's verbs (`status`, `build --install`, `verify`,
`extract`). It is not a shell — a browser tab that can run arbitrary commands
is a browser tab that can run arbitrary commands.

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
```

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
src/server/ide.mjs      the HTTP API (loopback only)
ui/                     the editor: index.html, app.js, styles.css
test/                   run.mjs, flow.test.mjs, api.test.mjs, skillswap.test.mjs, sweep.mjs
```

The server never writes a `.jsonl`. It writes `BLOCKS.md` and shells out to the
engine, which re-reads its own artefact and verifies it. The UI can be wrong
about text; it cannot invent a new way to corrupt a session.
