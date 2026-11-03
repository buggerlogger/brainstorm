// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// pins.mjs — context you add that does not get lost.
//
// THE PROBLEM. Anything you type into a block lives in that block. Rewind the
// conversation to an earlier turn, or rebuild into a new session id, and the
// block it lived in is dropped -- and your addition goes with it. That makes
// added context feel unsafe, so people stop adding it.
//
// THE FIX. A pin is stored OUTSIDE the transcript, keyed by the project's cwd,
// and re-applied on every build. Rewinding drops the block it was sitting in;
// the pin simply re-homes onto a block that survived. Building produces a new
// session id; the pin follows, because it was never keyed to the old one.
//
// It is written into the block delimited by markers:
//
//   <!-- pin:ab12cd -->
//   ...your text...
//   <!-- /pin:ab12cd -->
//
// so applying is idempotent: every apply strips the pin from EVERY block first
// and then writes it once into the chosen anchor. Re-applying cannot duplicate
// it, and disabling or deleting it removes it cleanly.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const STORE_DIR = join(homedir(), '.brainstorm');
const STORE = join(STORE_DIR, 'pins.json');

export const ANCHORS = ['last-user', 'first-user', 'last-block', 'block'];

function readStore() {
  if (!existsSync(STORE)) return {};
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    // A corrupt store must not take the IDE down with it; it is a convenience
    // file, and losing pins is better than refusing to open any session.
    return {};
  }
}

function writeStore(obj) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(obj, null, 2));
}

// Keyed by cwd, NOT by session id: a build makes a new session, and a pin that
// did not follow across it would defeat the whole point.
const keyFor = (cwd) => String(cwd || '(unknown)').toLowerCase();

export function loadPins(cwd) {
  const all = readStore();
  return all[keyFor(cwd)] || [];
}

export function savePins(cwd, pins) {
  const all = readStore();
  all[keyFor(cwd)] = pins;
  writeStore(all);
  return pins;
}

export function newPin({ text = '', anchor = 'last-user', blockId = null, label = '' } = {}) {
  return {
    id: randomUUID().slice(0, 8),
    label: label || firstWords(text),
    text,
    anchor: ANCHORS.includes(anchor) ? anchor : 'last-user',
    blockId,
    enabled: true,
    created: new Date().toISOString(),
  };
}

const firstWords = (s) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 37)}...` : t || 'pin';
};

const open = (id) => `<!-- pin:${id} -->`;
const close = (id) => `<!-- /pin:${id} -->`;

// stripPin removes a pin's region wherever it is, including a region whose
// closing marker was lost to a hand edit (then it strips to end of text).
export function stripPin(text, id) {
  const o = open(id);
  const c = close(id);
  let out = text;
  for (;;) {
    const a = out.indexOf(o);
    if (a < 0) break;
    const b = out.indexOf(c, a);
    const end = b < 0 ? out.length : b + c.length;
    out = out.slice(0, a) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

export function hasPin(text, id) {
  return text.includes(open(id));
}

function pickAnchor(blocks, pin) {
  const kept = blocks.filter((b) => b.keep !== false);
  if (!kept.length) return null;
  const users = kept.filter((b) => b.role === 'user' && b.kind === 'text');
  if (pin.anchor === 'block' && pin.blockId != null) {
    const exact = kept.find((b) => b.id === pin.blockId);
    // Fall through deliberately when the anchor block was rewound away: the
    // pin must survive, and the nearest sensible home is the last user turn.
    if (exact) return exact;
  }
  if (pin.anchor === 'first-user') return users[0] || kept[0];
  if (pin.anchor === 'last-block') return kept[kept.length - 1];
  return users[users.length - 1] || kept[kept.length - 1];
}

// applyPins mutates block text in place and reports what it did. Call it
// before every build and after every rewind.
export function applyPins(blocks, pins) {
  const report = [];
  for (const pin of pins) {
    // Strip first, everywhere. The anchor may have changed since last time.
    let removed = 0;
    for (const b of blocks) {
      if (!hasPin(b.text, pin.id)) continue;
      b.text = stripPin(b.text, pin.id);
      removed++;
    }
    if (!pin.enabled || !pin.text.trim()) {
      report.push({ id: pin.id, label: pin.label, applied: false, removedFrom: removed, reason: pin.enabled ? 'empty' : 'disabled' });
      continue;
    }
    const target = pickAnchor(blocks, pin);
    if (!target) {
      report.push({ id: pin.id, label: pin.label, applied: false, removedFrom: removed, reason: 'no block left to anchor to' });
      continue;
    }
    const body = `${open(pin.id)}\n${pin.text.replace(/\s+$/, '')}\n${close(pin.id)}`;
    target.text = target.text ? `${target.text.replace(/\s+$/, '')}\n\n${body}` : body;
    report.push({
      id: pin.id,
      label: pin.label,
      applied: true,
      removedFrom: removed,
      blockId: target.id,
      rehomed: pin.anchor === 'block' && pin.blockId != null && target.id !== pin.blockId,
      chars: pin.text.length,
    });
  }
  return report;
}

// ⛔ Deleting a pin has to strip it EXPLICITLY. applyPins only strips pins it
// still knows about, so dropping one from the list first left its text and its
// markers behind in the block forever -- the one thing a "remove" must not do.
export function purgePin(blocks, id) {
  let removed = 0;
  for (const b of blocks) {
    if (!hasPin(b.text, id)) continue;
    b.text = stripPin(b.text, id);
    removed++;
  }
  return removed;
}

// Blocks after `blockId` are dropped. Returns the ids it dropped, so the UI can
// say what rewinding actually did rather than just claiming it worked.
export function rewindTo(blocks, blockId) {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) throw new Error(`no block ${blockId} to rewind to`);
  const dropped = [];
  blocks.forEach((b, i) => {
    if (i <= idx) return;
    if (b.keep === false) return;
    b.keep = false;
    dropped.push(b.id);
  });
  return { keptThrough: blockId, dropped };
}
