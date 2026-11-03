# Window layout

```
┌─ titlebar ────────────────── session id — cwd ──── Save · Build · Build&Install ─┐
│ A │ EXPLORER / DEBUGGER / FIND / CHAT │ tabs: #5 text · 0/2 system (read only)   │
│ C │  ▾ aaaa2222            6 blocks   ├──────────────────────────────────────────┤
│ T │    ▾ User messages           2    │  1  Base directory for this skill: ...   │
│ I │      #1 Invoke the alpha-...104   │  2                                       │
│ V │      #5 Base directory ...   456  │  3  # ALPHA Protocol                     │
│ I │    ▸ Assistant messages      2    │  4                                       │
│ T │    ▸ Tool calls              1    │  5  You are operating under ...          │
│ Y │  SESSIONS                         │                                          │
│   │  ▸ ctf challenge            55    │                                          │
├───┴───────────────────────────────────┴──────────────────────────────────────────┤
│ TERMINAL │ FLOW │ PROBLEMS │ OUTPUT                                              │
│ $ flow source  -> 2 call(s), 57 frames                                           │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 6/6 blocks  678 ch  ~170 tok  4.98 ch/tok measured      frame 0/2 · system.2     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Activity bar (left edge): Explorer, Context debugger, Find in context, Resume
the chat.

## Debugger view

```
CONTEXT DEBUGGER
 [original transcript ▾] [Trace]
 [⏮] [◀] [Step ▶] [Run ⏩]
 2 API call(s), 57 frames · 4.98 ch/tok

 ▾ ▶ call 0  L23                    ~27.2K tok
     ∑ system 10.4K · tools 41.8K ·…   26 frames
       ⚙ system[0]                         62
       ⚙ system[1]                       2.0K ⛁     ⛁ = cache breakpoint
       ⚙ system[2]                       8.3K ⛁
     ● ƒ tool: Glob                       685       ● = breakpoint (right-click)
       ƒ tool: PowerShell                 9.5K
       ▸ messages[0].user text             564
```

## Keys

| key | does |
|---|---|
| `Ctrl+S` | save blocks to `BLOCKS.md` |
| `Ctrl+B` | build (without installing) |
| `Ctrl+F` | Find in context |
| `F10` | step one frame |
| `F5` | run to the next breakpoint |
| `Enter` in Find | jump to the next hit; `Shift+Enter` the previous |
| right-click a frame | toggle a breakpoint |
