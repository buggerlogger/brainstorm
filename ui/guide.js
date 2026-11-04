// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.

/* guide.js — the step-by-step guide. Everything is blurred except the one
   thing to use, and a card says what to do with it. A step moves on by itself
   when the app sees it done -- a session opened, a block edited, Save & Resume
   finished, claude answered -- and Next moves on by hand, so nobody is ever
   stuck on a step. While a step waits, the card says what for, with a spinner.

   The shade is one layer with a HOLE cut out by clip-path (evenodd): clicks
   in the hole reach the real button underneath, clicks anywhere else land on
   the shade and do nothing.

   ⛔ MEASURED on a first real run: auto-jump moved the app to the Recording
   view as claude's calls arrived, so "click your message" pointed at a tree
   that was not on screen -- everything blurred, nothing to click, only Skip.
   Now each step names the view it needs and the guide puts it back, and
   auto-jump is paused while a guide runs. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  const q = (sel) => document.querySelector(sel);
  const visible = (n) => !!n && !n.closest('[hidden]') && n.getClientRects().length > 0;
  const PAD = 6;
  // only the app's own window starts it unasked (the exe opens it with ?app=1):
  // a test page driving the UI must not find a guide over everything
  const IS_APP_WINDOW = new URLSearchParams(location.search).has('app');

  let tour = null;        // { name, steps, i }
  let mem = {};           // what a tour remembers between steps
  let timer = null;
  let shownKey = null;    // the card on screen, so it is rebuilt only when it changes
  let followWas = false;  // auto-jump was on before the guide paused it

  // --- what the steps look at ------------------------------------------------
  const sessionOpen = () => typeof S !== 'undefined' && !!S.state?.open;
  const gated = () => document.body.classList.contains('gated');
  const activeBlockTab = () => {
    const t = typeof activeTab === 'function' ? activeTab() : null;
    return t && t.kind === 'block' && !t.readonly ? t : null;
  };
  const userBlocks = () => [...document.querySelectorAll('#tree .node[data-folder="User messages"][data-block-id]')]
    .filter((n) => !n.classList.contains('notsent'));
  const notSentFolder = () => [...document.querySelectorAll('#tree .node[data-folder]')]
    .find((n) => !n.dataset.blockId && n.dataset.folder.startsWith('Not sent')) || null;
  function expandFolder(name) {
    if (!sessionOpen() || S.expanded.has(`g:${name}`)) return;
    S.expanded.add(`g:${name}`);
    renderTree();
  }
  const liveOn = () => B.settings?.liveHooks !== false;
  // claude's answers that started after the Save & Resume
  const answersAfterSave = () => (B.live?.()?.steps || [])
    .filter((s) => mem.saved && s.sentAt >= mem.saved - 2000 && s.endAt && s.text && !s.agentId);

  const words = (t) => [...new Set(String(t || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) || [])];
  function verdict() {
    const answer = answersAfterSave().pop();
    const before = new Set(words(mem.before));
    const added = words(mem.after).filter((w) => !before.has(w));
    if (answer) {
      const said = answer.text.trim().slice(0, 300);
      const used = added.filter((w) => answer.text.toLowerCase().includes(w));
      if (used.length) {
        return `claude answered:\n\n  ${said}\n\nIt used your edit ("${used.slice(0, 3).join('", "')}"): what changed is the context claude is sent, not just the screen.\n\nThat is the whole loop: open, edit, Save & Resume, ask.`;
      }
      return `claude answered:\n\n  ${said}\n\nCompare it with your edit${added.length ? ` ("${added.slice(0, 3).join('", "')}")` : ''}. If it does not match, ask more directly: claude answers from the context brainstorm built.`;
    }
    return 'Compare claude\'s answer in the terminal with your edit: it answers from the context brainstorm built, not from what the terminal showed before.\n\nThat is the whole loop: open, edit, Save & Resume, ask.';
  }

  // --- the tours ---------------------------------------------------------------
  // A step: title; text (a string or a function; a paragraph that starts with
  // two spaces is an example to type); view -> the view it needs ('explorer',
  // 'recording', 'probe'); target() -> the element to use; done() -> moves on
  // by itself, and wait says what it is waiting for meanwhile; skip() -> not
  // needed now; next -> the label of the Next button (every step has one);
  // alt -> a second way on; actions -> the buttons of a last card.
  const T = {};

  T.first = [
    { title: 'Welcome to brainstorm',
      text: 'brainstorm shows exactly what Claude Code sends to the model, lets you change it, and restarts claude on the changed version.\n\nIn about two minutes you will start a session, tell claude something, change what it remembers, and watch it use the change.',
      next: 'Start' },
    { title: 'Create a session',
      text: 'Click Create session to start a new claude.\n\nOr work on a session you already have: Use one of my sessions.',
      target: () => q('#gate-create'),
      skip: sessionOpen,
      alt: ['Use one of my sessions', () => { mem.pick = true; goTo('pick'); }],
      wait: 'waiting for you to click Create session',
      done: () => visible(q('#gate-new')) },
    { title: 'Pick the folder',
      text: 'Choose the project folder claude should work in, then click Start claude. A terminal opens with a new claude.',
      target: () => q('#gate-new'),
      skip: sessionOpen,
      wait: 'waiting for you to click Start claude',
      done: () => visible(q('#gate-new-wait')) },
    { title: 'Tell claude something',
      text: 'In the new terminal (answer claude\'s question if it asks whether to trust the folder), type a message with a fact in it, for example:\n\n  My favourite colour is green. Remember it.\n\nbrainstorm opens the session as soon as claude saves it.',
      target: () => q('#gate-new-wait'),
      skip: sessionOpen,
      wait: 'waiting for claude to save the session: it does with your first message',
      done: sessionOpen },
    { id: 'pick', title: 'Open one of your sessions',
      text: 'Click a session in the list. (Typing part of its id, its folder or its first prompt narrows the list.)',
      target: () => q('#gate .gate-card'),
      skip: () => sessionOpen() || !mem.pick,
      wait: 'waiting for you to open a session',
      done: sessionOpen },
    { title: 'This is the context',
      text: 'Every message, tool call and result claude is sent, as blocks.\n\nClick your message to open it.',
      view: 'explorer',
      onEnter: () => expandFolder('User messages'),
      target: () => userBlocks().pop() || q('#tree'),
      wait: 'waiting for you to open a message',
      done: () => !!activeBlockTab() },
    { title: 'Change what claude remembers',
      text: 'Edit the text: change the fact, for example green to purple.\n\nYou are editing what claude will be sent, not what the terminal shows.',
      view: 'explorer',
      onEnter: () => { mem.before = activeBlockTab()?.text ?? ''; },
      target: () => q('#editor'),
      wait: 'waiting for your edit',
      done: () => { const t = activeBlockTab(); return !!t && t.dirty && t.text !== mem.before; } },
    { title: 'Save & Resume',
      text: 'Click Save & Resume. brainstorm builds a new session with your edit, checks it the way the API would, and restarts claude on it in the same terminal: the chat stays on screen.',
      onEnter: () => { mem.after = activeBlockTab()?.text ?? mem.after; mem.saved = 0; },
      target: () => q('#btn-save-resume'),
      wait: 'waiting for Save & Resume to finish',
      done: () => !!mem.saved },
    { title: 'Ask claude',
      // the Live panel is in the Recording view: show it, so "here" is here
      view: () => (liveOn() ? 'recording' : null),
      text: () => `In the terminal, ask about the fact you changed, for example:\n\n  What is my favourite colour?\n\n${visible(q('#live'))
        ? 'claude\'s answer appears here as it streams, from inside claude.'
        : 'Then click I asked it.'}`,
      target: () => (visible(q('#live')) ? q('#live') : null),
      wait: 'waiting for claude\'s answer',
      done: () => answersAfterSave().length > 0,
      next: 'I asked it' },
    { title: 'Did claude get your edit?',
      text: verdict,
      actions: [['After a /compact', () => start('compact')], ['Make claude forget a rule', () => start('rules')], ['Done', () => finish()]] },
  ];

  T.compact = [
    { title: 'After a /compact',
      view: 'explorer',
      text: 'Typing /compact in claude swaps the conversation for a summary claude writes. The messages before it stay in the file, but claude is no longer sent them.\n\nTry it: type /compact in the terminal and wait until it finishes.' },
    { title: 'Load what changed',
      view: 'explorer',
      text: 'When the session changed under you, the tree says so. Click ⟳ to load it as it is now. (Save & Resume does this by itself first.)',
      target: () => q('#tree .node.stale') || q('#btn-refresh') },
    { title: 'Not sent',
      view: 'explorer',
      text: 'Everything before the compaction is filed here. Editing it changes nothing claude sees.',
      target: notSentFolder,
      skip: () => !notSentFolder() },
    { title: 'The summary is a block now',
      view: 'explorer',
      text: 'The summary is the first user message claude is sent. Open it and edit it like any other block: it is what claude remembers from before the compaction.',
      onEnter: () => expandFolder('User messages'),
      target: () => userBlocks()[0] || q('#tree') },
    { title: 'Never empty it',
      text: 'An empty message breaks the session: the API answers "messages.0: user messages must have non-empty content".\n\nTo remove the summary, drop it instead: right-click it, Drop. brainstorm never writes an empty message.' },
    { title: 'Save & Resume, then ask',
      text: 'Click Save & Resume, then ask claude about what you changed in the summary.',
      target: () => q('#btn-save-resume'),
      actions: [['Done', () => finish()]] },
  ];

  T.rules = [
    { title: 'Make claude forget a rule',
      view: 'explorer',
      text: 'claude follows rules from two places:\n\n1. What was said in this conversation ("never use X", "always answer in French"). brainstorm can take these out.\n\n2. Files claude reads on every request: CLAUDE.md and its memory files. They are not in the conversation, so edit the file itself.' },
    { title: 'Find the rule',
      text: 'Open Find in context.',
      target: () => q('.act[data-view="probe"]'),
      wait: 'waiting for you to open Find in context',
      done: () => visible(q('.view[data-view="probe"]')) },
    { title: 'Search for it',
      view: 'probe',
      text: 'Type a word from the rule: every block that holds it is listed. Click one to open it.',
      target: () => q('.view[data-view="probe"]') },
    { title: 'Take it out',
      view: 'explorer',
      text: 'Edit the rule out of the text, or drop the whole block: right-click it here, Drop. A dropped block is not sent; a dropped tool call takes its result with it.',
      target: () => q('#tree') },
    { title: 'Save & Resume, then test it',
      text: 'Click Save & Resume, then ask claude to do what the rule forbade.\n\nIf the rule comes back, it lives in a file: CLAUDE.md in the project or in ~/.claude, or claude\'s memory folder.',
      target: () => q('#btn-save-resume'),
      actions: [['Done', () => finish()]] },
  ];

  T.menu = [
    { title: 'Guides',
      text: 'Pick a guide. Each one blurs everything but the thing to use next, moves on when you have done it, and Next moves on by hand.',
      actions: [['A first edit', () => start('first')], ['After a /compact', () => start('compact')], ['Make claude forget a rule', () => start('rules')], ['Close', () => close()]] },
  ];

  // Shown OVER the current step while true; the step waits underneath.
  const INTERRUPTS = [
    { key: 'rewind', when: () => visible(q('#rewind-warn')),
      title: 'A warning worth reading',
      text: 'You edited a normal message, and a rewind in claude would remove it. For this guide, click Save here anyway.\n\nTo keep facts through every rewind, the main context is the place: it goes back in on every build.',
      target: () => q('#rewind-warn .modal-card') },
  ];

  // --- the engine -----------------------------------------------------------
  const cur = () => tour && tour.steps[tour.i];
  const viewOf = (s) => (typeof s.view === 'function' ? s.view() : s.view);

  // Auto-jump opens each new call as claude makes it -- and moves the app to
  // the Recording view to do it. Under a guide that pulls the very thing a
  // step points at off the screen, so it waits until the guide is closed.
  function pauseFollow() {
    if (typeof S !== 'undefined' && S.following && B.setFollow) {
      followWas = true;
      B.setFollow(false, false);
    }
  }

  function start(name) {
    if (!T[name]) return;
    if (name !== 'first' && name !== 'menu' && !sessionOpen()) {
      tour = { name: 'need', i: 0, steps: [{ title: 'Open a session first',
        text: 'This guide works on an open session.',
        actions: [['Open a session', () => { close(); B.openGate?.(); }], ['Close', () => close()]] }] };
    } else {
      tour = { name, steps: T[name], i: 0 };
    }
    if (name === 'first') mem = {};
    if (name !== 'menu') pauseFollow();
    shownKey = null;
    q('#guide').hidden = false;
    enter();
    if (!timer) timer = setInterval(update, 250);
  }

  function enter() {
    while (cur() && cur().skip?.()) tour.i++;
    if (!cur()) { finish(); return; }
    showView(cur());
    cur().onEnter?.();
    render();
  }

  function advance() {
    tour.i++;
    enter();
  }

  function goTo(id) {
    const i = tour.steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    tour.i = i;
    enter();
  }

  // the view a step needs, put back whatever moved it
  function showView(s) {
    const v = viewOf(s);
    if (v && !gated() && sessionOpen() && S.view !== v && typeof selectView === 'function') selectView(v);
  }

  function update() {
    if (!tour) return;
    if (tour.name !== 'menu') pauseFollow();
    const s = cur();
    if (!activeInterrupt()) {
      if (s.skip?.() || s.done?.()) { advance(); return; }
      showView(s);
    }
    render();
  }

  function activeInterrupt() {
    if (!tour || tour.name === 'menu' || tour.name === 'need') return null;
    return INTERRUPTS.find((x) => x.when()) || null;
  }

  // closes the guide; finish() also stops it starting by itself
  function close() {
    tour = null;
    shownKey = null;
    clearInterval(timer);
    timer = null;
    q('#guide').hidden = true;
    if (followWas) { followWas = false; B.setFollow?.(true, false); }
  }

  async function finish() {
    const auto = B.settings?.showGuide !== false;
    close();
    if (!auto) return;
    try {
      const r = await api('/api/settings', { showGuide: false });
      B.settings = r.settings;
    } catch { /* it shows again next start; nothing worse */ }
  }

  function paragraphs(text) {
    const frag = document.createDocumentFragment();
    for (const para of String(text).split('\n\n')) {
      if (para.startsWith('  ')) {
        frag.appendChild(el('pre', 'guide-example', para.trim()));
      } else {
        frag.appendChild(el('p', '', para));
      }
    }
    return frag;
  }

  function button(label, cls, fn) {
    const b = el('button', `btn sm ${cls}`, label);
    b.addEventListener('click', fn);
    return b;
  }

  function render() {
    if (!tour) return;
    const x = activeInterrupt();
    const s = x || cur();
    const key = x ? `x:${x.key}` : `${tour.name}:${tour.i}`;
    const fresh = key !== shownKey;
    if (fresh) {
      shownKey = key;
      const counted = !x && tour.steps.length > 1;
      q('#guide-step').textContent = counted ? `${tour.i + 1} / ${tour.steps.length}` : '';
      q('#guide-title').textContent = s.title;
      q('#guide-text').replaceChildren(paragraphs(typeof s.text === 'function' ? s.text() : s.text));
      // waiting for the person (or for claude): say for what, and that it is
      const waiting = !x && !!s.done && !!s.wait;
      q('#guide-wait').hidden = !waiting;
      q('#guide-wait-text').textContent = waiting ? `${s.wait}…` : '';
      const acts = q('#guide-actions');
      acts.replaceChildren();
      if (!x && s.actions) {
        s.actions.forEach(([label, fn], i) => acts.appendChild(button(label, i === 0 ? 'primary' : '', fn)));
      } else {
        if (tour.name !== 'menu') acts.appendChild(button('Skip guide', 'ghost skip', () => finish()));
        if (!x && s.alt) acts.appendChild(button(s.alt[0], '', s.alt[1]));
        // every step has a way on, by hand: nobody is stuck if something is off
        if (!x) acts.appendChild(button(s.next || 'Next', 'primary', advance));
      }
    }
    const target = s.target?.() || null;
    // a target scrolled out of its list (a long tree) is brought into view once
    if (fresh && target && visible(target)) {
      const r = target.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) target.scrollIntoView({ block: 'center' });
    }
    place(target);
  }

  // the hole, the ring around it, and the card beside it
  function place(target) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const shade = q('#guide-shade');
    const ring = q('#guide-ring');
    const card = q('#guide-card');
    const r = target && visible(target) ? target.getBoundingClientRect() : null;
    if (!r || r.width === 0) {
      shade.style.clipPath = '';
      ring.hidden = true;
      card.style.width = '';
      card.style.left = `${Math.max(16, (W - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (H - card.offsetHeight) / 2)}px`;
      return;
    }
    const x = Math.max(0, r.left - PAD);
    const y = Math.max(0, r.top - PAD);
    const w = Math.min(W, r.right + PAD) - x;
    const h = Math.min(H, r.bottom + PAD) - y;
    shade.style.clipPath = `path(evenodd, "M0 0H${W}V${H}H0Z M${x} ${y}h${w}v${h}h${-w}Z")`;
    ring.hidden = false;
    Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    // below the hole if it fits, else above, else beside it (narrowed to the
    // room there): the card must not sit on what it asks you to click. Only
    // when no side has room does it go over the hole, at the bottom.
    card.style.width = '';
    let cw = card.offsetWidth;
    let ch = card.offsetHeight;
    const clampX = (v) => Math.min(Math.max(16, v), W - cw - 16);
    const clampY = (v) => Math.min(Math.max(16, v), H - ch - 16);
    const room = { below: H - (y + h) - 28, above: y - 28, right: W - (x + w) - 28, left: x - 28 };
    let left;
    let top;
    if (room.below >= ch) { top = y + h + 12; left = clampX(x + w / 2 - cw / 2); }
    else if (room.above >= ch) { top = y - 12 - ch; left = clampX(x + w / 2 - cw / 2); }
    else if (Math.max(room.left, room.right) >= 200) {
      const side = room.right >= room.left ? 'right' : 'left';
      if (room[side] < cw) { cw = room[side]; card.style.width = `${cw}px`; ch = card.offsetHeight; }
      left = side === 'right' ? x + w + 12 : x - 12 - cw;
      top = clampY(y + h / 2 - ch / 2);
    } else {
      left = clampX(x + w / 2 - cw / 2);
      top = H - ch - 16;
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // --- wiring -----------------------------------------------------------------
  const prevSaved = B.onSaveResumed;
  B.onSaveResumed = (r) => { prevSaved?.(r); if (tour) mem.saved = Date.now(); };

  q('#btn-guide').addEventListener('click', () => start('menu'));
  window.addEventListener('resize', () => { if (tour) render(); });
  document.addEventListener('keydown', (e) => { if (tour && e.key === 'Escape' && tour.name === 'menu') close(); });

  // first start: once the settings are in, in the app's own window only
  const prevBoot = B.onBoot;
  B.onBoot = () => {
    prevBoot?.();
    if (!IS_APP_WINDOW) return;
    let tries = 0;
    const wait = setInterval(() => {
      if (B.settings || ++tries > 40) {
        clearInterval(wait);
        if (B.settings && B.settings.showGuide !== false && !tour) start('first');
      }
    }, 125);
  };

  B.guide = { start, close, finish, active: () => (tour ? { name: tour.name, step: tour.i, key: shownKey } : null) };
})();
