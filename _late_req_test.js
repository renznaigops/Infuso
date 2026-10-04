/* TEMP harness (deleted after run): loads js/app.js in a stubbed DOM + fixed clock and exercises
   the late-reason Accept/Reject flow end to end (notification -> waiver -> deductions -> payroll). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

// Fixed "now": Sun Oct 4 2026, 15:45 local (matches the demo screenshot date)
const RealDate = Date;
const FIXED = new RealDate(2026, 9, 4, 15, 45, 0);
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED.getTime()); else super(...a); }
  static now() { return FIXED.getTime(); }
}
globalThis.Date = FakeDate;

// localStorage (seed BEFORE app loads)
const mem = new Map();
const ls = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), clear: () => mem.clear(),
};
const seed = (k, v) => mem.set(k, JSON.stringify(v));
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });

// --- minimal DOM ---
function makeEl(sel) {
  const cs = new Set();
  const el = {
    sel, innerHTML: '', textContent: '', value: '', checked: false, hidden: false, className: '',
    style: {}, dataset: {}, files: null, _h: {},
    classList: {
      add: c => cs.add(c), remove: c => cs.delete(c), contains: c => cs.has(c),
      toggle: (c, f) => { if (f === undefined) { cs.has(c) ? cs.delete(c) : cs.add(c); } else { f ? cs.add(c) : cs.delete(c); } },
    },
    addEventListener(t, f) { (el._h[t] = el._h[t] || []).push(f); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, remove() {}, focus() {}, click() {},
    querySelector(s) { return doc.querySelector(s); }, closest() { return null; }, contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollIntoView() {}, getContext() { return null; }, parentNode: null, parentElement: null,
  };
  return el;
}
const els = {};
const doc = {
  querySelector(s) { return els[s] || (els[s] = makeEl(s)); },
  querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {},
  createElement(t) { return makeEl('<' + t + '>'); },
  title: 'harness', visibilityState: 'visible',
};
doc.body = makeEl('body'); doc.documentElement = makeEl('html');
Object.defineProperties(globalThis, {
  document: { value: doc, configurable: true, writable: true },
  navigator: { value: { userAgent: 'node', clipboard: { writeText: async () => {} } }, configurable: true, writable: true },
  location: { value: { hash: '', href: 'file:///harness', reload() {} }, configurable: true, writable: true },
  history: { value: { pushState() {}, replaceState() {} }, configurable: true, writable: true },
});
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.innerWidth = 1280; globalThis.innerHeight = 800;
globalThis.__toasts = [];

// --- app seeds: 2 late employees (55 min late, both with a reason) ---
const dayKey = '2026-10-04';
seed('emps', {
  'STF-001': { name: 'Ana Reyes', pos: 'Dine Staff', contact: '09171234567', hired: '2024-01-01', shift: 1, active: true, start: 600, sch: '10:00 AM – 7:00 PM', rate: 60 },
  'STF-002': { name: 'Ben Cruz', pos: 'Kitchen Staff', contact: '09181234567', hired: '2024-02-01', shift: 1, active: true, start: 600, sch: '10:00 AM – 7:00 PM', rate: 60 },
});
seed('sched', { [dayKey]: { 'STF-001': { t: 'morning', in: 885, out: 1020 }, 'STF-002': { t: 'morning', in: 885, out: 1020 } } });
const tin = new RealDate(2026, 9, 4, 15, 40, 0).getTime(); // 15:40 vs 14:45 start = 55 min late
seed('logs', [
  { id: 'STF-001', name: 'Ana Reyes', type: 'in', ts: tin, note: 'Traffic on NLEX' },

  { id: 'STF-002', name: 'Ben Cruz', type: 'in', ts: tin + 60000, note: 'Tricycle broke down' },
]);
seed('seedDay', new RealDate(2026, 9, 4).toDateString()); // stop seedLogs() from overwriting
seed('idv', 2); seed('payv', 5); seed('lateReq', []);
seed('cfg', { grace: 15, notifyLate: true, notifyMin: 0, requirePin: false, blockUnsched: true, fallbackRate: 80 });

// --- load the real app ---
try { vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8'), { filename: 'app.js' }); }
catch (e) { console.error('LOAD_FAIL:', (e && e.stack) || e); process.exit(1); }
const run = c => vm.runInThisContext(c);
let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('PASS  ' + name + ' = ' + g);
  else { fails++; console.log('FAIL  ' + name + ' got ' + g + ', want ' + w); }
};

(async () => {
  // 1) notification carries the reason + the auto-deduction key, still undecided
  eq('notif count', run('lateNotifs().length'), 2);
  eq('note carried', run('lateNotifs().find(x => x.id === "STF-001").note'), 'Traffic on NLEX');
  eq('late mins', run('lateNotifs().find(x => x.id === "STF-001").mins'), 55);
  eq('deduction key', run('lateNotifs().find(x => x.id === "STF-001").k'), 'a-STF-001-2026-10-04-t');
  eq('decision pending', run('lateNotifs().find(x => x.id === "STF-001").dec'), null);

  // 2) automatic tardiness exists today for both (₱60/hr -> ₱55 each)
  eq('auto deds today', run('autoDeds(new Date(2026,9,4), new Date(2026,9,4)).map(x => x.id + ":" + x.amount)'), ['STF-001:55', 'STF-002:56']); // 15:40 -> 55 min, 15:41 -> 56 min

  // 3) bell renders Accept/Reject
  run('renderBell()');
  const html = () => els['#bell-panel'].innerHTML;
  eq('bell shows Accept/Reject', /data-reqk="a-STF-001-2026-10-04-t"[\s\S]*Accept[\s\S]*Reject/.test(html()), true);
  eq('bell shows amount', html().includes('₱55.00'), true);
  eq('bell shows note', html().includes('Traffic on NLEX'), true);
  eq('badge pending count', els['#bell-dot'].textContent, '2');

  // 4) ACCEPT Ana -> deduction waived
  run('confirmCard = async () => true; toast = m => { globalThis.__toasts.push(m); };');
  const click = els['#bell-panel']._h.click[0];
  await click({ target: { closest: s => s === '[data-reqk]' ? { dataset: { reqk: 'a-STF-001-2026-10-04-t', dec: 'ok' } } : null } });
  eq('decided ok', run('lateNotifs().find(x => x.id === "STF-001").dec'), 'ok');
  eq('deduction removed (autoDeds)', run('autoDeds(new Date(2026,9,4), new Date(2026,9,4)).map(x => x.id)'), ['STF-002']);
  eq('persisted in lateReq', JSON.parse(mem.get('lateReq')).map(r => r.k + ':' + r.dec), ['a-STF-001-2026-10-04-t:ok']);
  eq('bell shows accepted badge', html().includes('Accepted · deduction removed'), true);
  eq('badge now 1', els['#bell-dot'].textContent, '1');
  eq('toast mentions removal', __toasts[0].includes('removed'), true);

  // 5) REJECT Ben -> deduction stays
  await click({ target: { closest: s => s === '[data-reqk]' ? { dataset: { reqk: 'a-STF-002-2026-10-04-t', dec: 'no' } } : null } });
  eq('decided no', run('lateNotifs().find(x => x.id === "STF-002").dec'), 'no');
  eq('deduction stays (autoDeds)', run('autoDeds(new Date(2026,9,4), new Date(2026,9,4)).map(x => x.id)'), ['STF-002']);
  eq('bell shows rejected badge', html().includes('Rejected · deduction stays'), true);
  eq('badge empty when none pending', els['#bell-dot'].textContent, '');
  eq('lateReq has both', JSON.parse(mem.get('lateReq')).map(r => r.dec).sort(), ['no', 'ok']);

  // 6) payroll reflects it: Ana has no tardiness today, Ben still does
  const rows = run('JSON.stringify(payRows(curStart(), false).map(r => ({ id: r.id, tardToday: r.c.ds.filter(d => d.type === "tardiness" && d.date === "2026-10-04").length })))');
  eq('payroll tardiness today', JSON.parse(rows), [{ id: 'STF-001', tardToday: 0 }, { id: 'STF-002', tardToday: 1 }]);

  // 7) reset demo clears requests
  await run('resetDemo()');
  eq('reset clears REQ', run('REQ.length'), 0);
  eq('reset clears store', JSON.parse(mem.get('lateReq')), []);

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('HARNESS_FAIL:', (e && e.stack) || e); process.exit(1); });

