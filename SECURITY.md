# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.

This uses GitHub's private vulnerability reporting: only you and the
maintainer see the report until a fix is out. Please include what you did,
what happened, and the version (`brainstorm.exe --version`).

Please give a reasonable time to fix it before any public disclosure. You will
get an answer in the report itself, and credit in the release notes if you
want it.

## What is in scope

brainstorm runs on your own machine, so the things that matter most are the
ones that let something *else* act through it:

- the local server the app window talks to (`127.0.0.1`), and anything that
  can reach it
- Save & Resume and the session windows it opens and restarts claude in
- the `brainstorm-live` plugin that runs inside claude
- `npx github:buggerlogger/brainstorm setup` and the release exe

## Supported versions

Fixes go into the latest release and `master`. Older releases are not patched:
update with `npx github:buggerlogger/brainstorm setup`, or download the latest
release.
