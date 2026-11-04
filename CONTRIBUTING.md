# Contributing to brainstorm

Thanks for wanting to help. brainstorm is a context debugger and editor for
Claude Code: it opens a session, shows what claude is sent, lets you change it,
and resumes claude on the edited session.

## Run it from source

You need Node 22 or later and Claude Code (`claude`) on your PATH. Windows is
the platform that works end to end today; the session windows (the terminal
claude runs in) are Windows-only for now.

```
git clone https://github.com/buggerlogger/brainstorm
cd brainstorm
node bin/app.mjs          # the app, in an Edge window
```

`node scripts/build-exe.mjs` builds `dist/brainstorm.exe`, the single-file app.

## Tests

```
node test/run.mjs          # fast: no claude, no network
node test/run.mjs --all    # also the server, headless Edge, and a REAL claude
node test/run.mjs --exe    # also builds the exe and tests it
```

Every test run gets its own app data folder (`BRAINSTORM_HOME`), so tests
never touch your settings, terminals, pins or live events. A test that starts a
server or a claude must keep it that way. The `--all` suites that run a real
claude make real API calls.

## How changes are made here

- **Measure before you fix.** Most bugs in this repo were not what they first
  looked like. Reproduce the problem against the real thing (a real
  transcript, the real API, a real window), then fix it, then keep the
  reproduction as a test.
- **Say what was measured in the code.** A comment that starts with `⛔`
  records a bug that happened, with the numbers, so nobody brings it back.
- **Never invent context.** The tool shows what a transcript says and what the
  API reports. When something cannot be known (the words of the thinking,
  which tokens the cache served), the UI says so instead of guessing.
- **Keep the person's data safe.** Nothing writes under `~/.claude` except an
  install the person asked for; nothing changes a session that is open in a
  terminal without the person's action.

Small pull requests with a test are the easiest to review. For anything
larger, open an issue first so we can agree on the approach.

## Where things are

`docs/layout.md` and the *Layout* section of the README list the modules.
The engine (`src/ctx.mjs`) extracts a session into editable blocks and builds
it back; the server (`src/server/ide.mjs`) is the API the UI (`ui/`) uses;
`mod/brainstorm-live` is the Claude Code plugin that streams what claude does.

## License

By contributing you agree that your contribution is licensed under the
Apache License 2.0, like the rest of the project (see `LICENSE` and `NOTICE`).
