// ui.test.mjs — static wiring check for the front end, no browser required.
//
//   node test/ui.test.mjs
//
// The failure this catches: app.js does `$('#pin-save').addEventListener(...)`
// for an id that index.html does not have. Nothing throws at load time in a
// way you would notice -- the button simply does nothing, for ever. A browser
// test catches it too, but only if you happen to click that button, and the
// browser is the slowest, flakiest thing in the loop.
//
// It also checks the reverse: markup that declares an id or a data-view no
// script ever reads, which is dead UI.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const uniq = (a) => [...new Set(a)];
const matchAll = (re, s) => uniq([...s.matchAll(re)].map((m) => m[1]));

// --- ids -------------------------------------------------------------------
const htmlIds = matchAll(/\sid="([^"]+)"/g, html);
const jsIds = matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g, js);

console.log(`\n  ${htmlIds.length} ids in markup, ${jsIds.length} referenced by script\n`);

const missing = jsIds.filter((id) => !htmlIds.includes(id));
check(missing.length === 0, 'every id the script reaches for exists in the markup', missing.length ? missing.join(', ') : '');

const unread = htmlIds.filter((id) => !jsIds.includes(id) && !js.includes(`'${id}'`) && !js.includes(`"${id}"`));
check(unread.length === 0, 'no id in the markup is dead', unread.length ? unread.join(', ') : '');

// --- views and panels ------------------------------------------------------
const actViews = matchAll(/class="act[^"]*"\s+data-view="([^"]+)"/g, html);
const sectionViews = matchAll(/class="view"\s+data-view="([^"]+)"/g, html);
const viewsNoClassFirst = matchAll(/<section class="view" data-view="([^"]+)"/g, html);
const allSections = uniq([...sectionViews, ...viewsNoClassFirst]);
check(
  actViews.every((v) => allSections.includes(v)),
  'every activity-bar button has a matching view section',
  actViews.filter((v) => !allSections.includes(v)).join(', '),
);
check(
  allSections.every((v) => actViews.includes(v)),
  'every view section has an activity-bar button',
  allSections.filter((v) => !actViews.includes(v)).join(', '),
);

const ptabs = matchAll(/class="ptab[^"]*"\s+data-panel="([^"]+)"/g, html);
const pbodies = matchAll(/class="panel-body"\s+data-panel="([^"]+)"/g, html);
check(ptabs.length > 0 && ptabs.every((p) => pbodies.includes(p)), 'every panel tab has a body', ptabs.filter((p) => !pbodies.includes(p)).join(', '));

// --- the hidden-rule regression -------------------------------------------
// A UA sheet's [hidden] { display: none } loses to any display declaration, so
// every view rendered at once until an explicit rule was added. If someone
// gives .view or .panel-body a display without re-adding it, it comes back.
check(/\.view\[hidden\]/.test(css) && /\.panel-body\[hidden\]/.test(css),
  'the [hidden] override exists for views and panel bodies');

// --- no blocking dialogs ---------------------------------------------------
// confirm()/alert()/prompt() freeze the document: a rewind prompt once left the
// IDE unable to even reload until a human clicked it.
const blocking = ['confirm(', 'alert(', 'prompt('].filter((f) => new RegExp(`(^|[^.\\w])${f.replace('(', '\\(')}`, 'm').test(js));
check(blocking.length === 0, 'no blocking window dialogs in the front end', blocking.join(', '));
check(/function askConfirm/.test(js), 'the non-blocking confirm bar is present');

// --- api routes the UI calls must exist in the server ----------------------
const server = readFileSync(join(ROOT, 'src', 'server', 'ide.mjs'), 'utf8');
const called = matchAll(/api\('(\/api\/[a-z-]+)/g, js).concat(matchAll(/fetch\('(\/api\/[a-z-]+)/g, js));
const routes = matchAll(/'(?:GET|POST) (\/api\/[a-z-]+)'/g, server);
const unknown = uniq(called).filter((r) => !routes.includes(r));
check(unknown.length === 0, 'every endpoint the UI calls is a route on the server', unknown.join(', '));
console.log(`    routes: ${routes.join(' ')}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
