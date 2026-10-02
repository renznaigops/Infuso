/* InfusoPay prototype – hash-routed views: home, login, register, scan, verify, dashboard */
'use strict';

/* ---------- Demo data & state ---------- */
const POSITIONS = ['Kitchen Staff', 'Dine Staff'];
const fmtPhone = s => { const d = String(s).replace(/\D/g, ''); return /^09\d{9}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : null; }; // PH mobile: 09XX XXX XXXX
const ROSTER = [
  ['Ana Reyes', 'Dine Staff'], ['Ben Cruz', 'Dine Staff'], ['Carla Santos', 'Kitchen Staff'], ['Daniel Garcia', 'Dine Staff'], ['Elena Mendoza', 'Dine Staff'],
  ['Francis Dela Cruz', 'Kitchen Staff'], ['Grace Villanueva', 'Dine Staff'], ['Hector Ramos', 'Dine Staff'], ['Isabel Navarro', 'Dine Staff'], ['Jonas Bautista', 'Dine Staff'],
  ['Katrina Lopez', 'Dine Staff'], ['Luis Aquino', 'Kitchen Staff'], ['Maya Torres', 'Dine Staff'], ['Noel Pascual', 'Kitchen Staff'], ['Olivia Castillo', 'Dine Staff'],
];
const SHIFTS = [[480, '8:00 AM – 5:00 PM'], [600, '10:00 AM – 7:00 PM'], [900, '3:00 PM – 12:00 AM']]; // [start minute, label]
const EMP = {}; // id -> { name, pos, contact, hired, shift, active, start, sch }
const pad = n => String(n).padStart(3, '0');
const withShift = e => { e.start = SHIFTS[e.shift][0]; e.sch = SHIFTS[e.shift][1]; return e; };
function defaultEmps() {
  const o = {};
  ROSTER.forEach(([name, pos], i) => {
    const d = new Date(2024, 0, 10 + i * 38), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    o['STF-' + pad(i + 1)] = withShift({
      name, pos, rate: 80, shift: i % 3 === 1 ? 1 : 0, active: i < 13, hired: `${d.getFullYear()}-${mm}-${dd}`,
      contact: `09${['17', '18', '19', '16'][i % 4]} ${pad(120 + i * 53)} ${String(1000 + i * 731).slice(-4)}`
    });
  });
  return o;
}
const SEED = { username: 'admin', password: 'admin123', pin: '123456', business: 'InfusoPay', name: 'Maria Santos' };

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
};
try {
  const savedAcct = store.get('acct', null);
  if (savedAcct && savedAcct.business === 'InfusoPay Café') { savedAcct.business = SEED.business; store.set('acct', savedAcct); }
} catch (e) {}
const fmtTime = d => new Date(d).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
const go = h => { if (location.hash === '#/' + h) route(); else location.hash = '#/' + h; };

let sess = null, pending = null, stage = 2, stream = null, camToken = 0, raf = null, lastScan = { c: null, t: 0 };

/* ---------- One-time migration: staff IDs EMP-### → STF-### ---------- */
if (store.get('idv', 0) < 2) {
  const rId = v => typeof v === 'string' && v.startsWith('EMP-') ? 'STF-' + v.slice(4) : v; // rename a single id
  const emps = store.get('emps', null);
  if (emps) { const o = {}; Object.keys(emps).forEach(k => o[rId(k)] = emps[k]); store.set('emps', o); }
  const sched = store.get('sched', null);
  if (sched) { Object.keys(sched).forEach(d => { const day = sched[d] || {}, o = {}; Object.keys(day).forEach(k => o[rId(k)] = day[k]); sched[d] = o; }); store.set('sched', sched); }
  const logs = store.get('logs', null);
  if (Array.isArray(logs)) { logs.forEach(x => { x.id = rId(x.id); }); store.set('logs', logs); }
  const deds = store.get('deds', null);
  if (Array.isArray(deds)) { deds.forEach(x => { x.id = rId(x.id); }); store.set('deds', deds); }
  ['pay', 'paysnap'].forEach(key => { const m = store.get(key, null); if (m) { const o = {}; Object.keys(m).forEach(k => o[k.replace(/EMP-/g, 'STF-')] = m[k]); store.set(key, o); } });
  store.set('idv', 2);
}

/* ---------- Demo data ---------- */
Object.assign(EMP, store.get('emps', null) || defaultEmps());
const saveEmps = () => store.set('emps', EMP);
Object.values(EMP).forEach(e => { if (!POSITIONS.includes(e.pos)) e.pos = /kitchen|dishwasher/i.test(e.pos) ? 'Kitchen Staff' : 'Dine Staff'; if (!(e.rate > 0)) e.rate = 80; delete e.face; }); // keep older saved data in line with the new rules
saveEmps();
const activeIds = () => Object.keys(EMP).filter(id => EMP[id].active);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------- Schedules: data (per-day overrides; everything else follows the default shift) ---------- */
const SHIFT_TYPES = { morning: { label: 'Morning', in: 480, out: 1020 }, afternoon: { label: 'Afternoon', in: 600, out: 1140 }, night: { label: 'Night', in: 900, out: 1440 } };
const TYPE_BY_SHIFT = ['morning', 'afternoon', 'night'];
const TYPE_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night', off: 'Day off', leave: 'On leave' };
const SCH = store.get('sched', {}); // { 'YYYY-MM-DD': { 'STF-001': { t, in, out } } }
const saveSch = () => store.set('sched', SCH);
const dkey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function getSched(id, d) {
  const o = SCH[dkey(d)]?.[id]; if (o) return o.t === 'leave' ? { t: 'off' } : o; // the only statuses are Scheduled and Day off
  return defSched(id, d);
}
function defSched(id, d) { // the staff's default pattern, used when a day has no edit
  const wd = (d.getDay() + 6) % 7; // Mon = 0
  if (wd === (+id.slice(4) - 1) % 7) return { t: 'off' }; // default: one weekly day off, staggered
  const t = TYPE_BY_SHIFT[EMP[id].shift] || 'morning', p = SHIFT_TYPES[t];
  return { t, in: p.in, out: p.out };
}
const schedChanged = (id, d) => { // true when an edit made this day differ from the default pattern
  if (!SCH[dkey(d)]?.[id]) return false; const b = defSched(id, d), s = getSched(id, d);
  return (b.in ?? null) !== (s.in ?? null) || (b.out ?? null) !== (s.out ?? null);
};
const startOf = id => getSched(id, new Date()).in ?? 1e9; // scheduled start today (minutes), or 1e9 when not working
const GRACE = 15; // minutes after scheduled start before time in counts as late
function isLateNow(id, ts = Date.now()) { // minutes late past scheduled start (0 when on time / not scheduled)
  const s = startOf(id); if (s > 1e8) return 0;
  const d = new Date(ts), m = d.getHours() * 60 + d.getMinutes();
  return m > s + GRACE ? m - s : 0;
}
const fmtMin = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const fmtShort = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`; };
const schedText = id => { const s = getSched(id, new Date()); return s.in != null ? `${fmtMin(s.in)} – ${fmtMin(s.out)}` : TYPE_LABEL[s.t] + ' today'; };
const HIST = [[12, 2, 1], [13, 1, 1], [11, 3, 1], [13, 2, 0], [10, 2, 3], [12, 1, 2]]; // previous 6 days: [on time, late, absent]
const OFFSETS = [-10, -5, 0, 3, -2, 20, -8, 5, -1, 25, 2]; // minutes vs shift start; first 11 staff are already in today
function seedLogs() {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  return activeIds().filter(id => { const s = getSched(id, day); return s.in != null && s.t !== 'night'; }).slice(0, OFFSETS.length)
    .map((id, i) => ({ id, name: EMP[id].name, type: 'in', ts: day.getTime() + (getSched(id, day).in + OFFSETS[i]) * 60000 }));
}
if (store.get('seedDay', '') !== new Date().toDateString()) { store.set('logs', seedLogs()); store.set('seedDay', new Date().toDateString()); }

/* ---------- UI helpers ---------- */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast card px-4 py-3 text-sm shadow-lg max-w-sm w-full';
  el.style.borderLeft = `4px solid var(--${type === 'ok' ? 'ok' : 'err'})`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

setInterval(() => {
  const d = new Date();
  $$('[data-clock=date]').forEach(e => e.textContent = d.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
  $$('[data-clock=time]').forEach(e => e.textContent = fmtTime(d));
}, 1000);

/* ---------- Theme (light default, dark optional) ---------- */
function paintTheme() {
  const dark = document.documentElement.dataset.theme === 'dark', b = $('#theme');
  b.textContent = dark ? '☀️' : '🌙';
  b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { }
  paintTheme();
});
paintTheme();

/* ---------- Auth (client-side demo only) ---------- */
$$('[data-eye]').forEach(b => b.addEventListener('click', () => {
  const i = $('#' + b.dataset.eye), show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  b.textContent = show ? 'Hide' : 'Show';
}));
$('#lu').value = store.get('remember', '');
/* Forgot password (demo-safe): verify username + 6-digit payroll PIN, then set a new password. No email/backend. */
const fpModal = $('#forgot-modal');
function openForgot() {
  const a = store.get('acct', SEED);
  $('#fp-user').value = $('#lu').value.trim() || a.username || '';
  $('#fp-pin').value = ''; $('#fp-new').value = ''; $('#fp-confirm').value = '';
  $('#fp-err').classList.add('hidden');
  fpModal.classList.remove('hidden'); fpModal.classList.add('flex');
  $('#fp-user').focus();
}
const closeForgot = () => { fpModal.classList.add('hidden'); fpModal.classList.remove('flex'); };
$('#forgot').addEventListener('click', openForgot);
$('#fp-x').addEventListener('click', closeForgot); $('#fp-cancel').addEventListener('click', closeForgot);
addEventListener('keydown', e => { if (e.key === 'Escape') closeForgot(); });
$('#fp-pin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('#fp-form').addEventListener('submit', e => {
  e.preventDefault();
  const err = $('#fp-err'), fail = m => { err.textContent = m; err.classList.remove('hidden'); };
  const a = store.get('acct', SEED);
  const u = $('#fp-user').value.trim(), pin = $('#fp-pin').value, nw = $('#fp-new').value, cf = $('#fp-confirm').value;
  if (!u) return fail('Enter your username.');
  if (u.toLowerCase() !== String(a.username).toLowerCase()) return fail('No account found for that username on this device.');
  if (!a.pin) return fail('This account has no payroll PIN yet, so identity can’t be verified. Log in and set a PIN first.');
  if (pin !== a.pin) return fail('Incorrect payroll PIN.');
  if (nw.length < 6) return fail('Use a new password with at least 6 characters.');
  if (nw !== cf) return fail('New passwords don’t match.');
  a.password = nw; store.set('acct', a); if (sess) sess.password = nw;
  closeForgot(); toast('Password reset. Log in with your new password.');
  $('#lu').value = u; $('#lp').value = ''; $('#lp').focus();
});

$('#login-form').addEventListener('submit', e => {
  e.preventDefault();
  const a = store.get('acct', SEED);
  if ($('#lu').value.trim().toLowerCase() === a.username.toLowerCase() && $('#lp').value === a.password) {
    store.set('remember', $('#rem').checked ? a.username : '');
    sess = a; $('#lp').value = ''; $('#login-err').classList.add('hidden');
    go('home');
  } else $('#login-err').classList.remove('hidden');
});

$('#reg-form').addEventListener('submit', e => {
  e.preventDefault();
  const g = id => $(id).value.trim(), err = $('#reg-err');
  const bad = !g('#rb') || !g('#rn') || !g('#ru') ? 'Enter your business name, full name and username.'
    : $('#rp').value.length < 6 ? 'Use a password with at least 6 characters.'
      : $('#rp').value !== $('#rc').value ? 'Passwords don’t match.'
        : !/^\d{6}$/.test($('#rpin').value) ? 'The PIN must be exactly 6 digits.'
          : $('#rpin').value !== $('#rpc').value ? 'PINs don’t match.'
            : !$('#rt').checked ? 'Accept the terms to continue.' : '';
  if (bad) { err.textContent = bad; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  sess = { username: g('#ru'), password: $('#rp').value, business: g('#rb'), name: g('#rn'), email: g('#re'), pin: $('#rpin').value };
  store.set('acct', sess); e.target.reset();
  toast('Account created.'); go('home');
});

/* ---------- Payroll PIN: opens the payroll module; locks again when you leave it ---------- */
let unlocked = false, pinTarget = 'dashboard', pinFails = 0, pinLock = 0;
$$('#rpin, #rpc, #pin-in, #pin-in2').forEach(i => i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); }));
function paintPin() {
  const setup = !sess.pin; // accounts created before PINs existed set one on first use
  $('#pin-title').textContent = setup ? 'Set your payroll PIN' : 'Enter your PIN';
  $('#pin-sub').textContent = setup ? 'Create a 6-digit PIN. You’ll use it to open payroll.' : 'Enter your 6-digit PIN to open payroll.';
  $('#pin-w2').classList.toggle('hidden', !setup); $('#pin-btn').textContent = setup ? 'Save PIN and continue' : 'Unlock payroll';
  $('#pin-in').value = ''; $('#pin-in2').value = ''; $('#pin-err').classList.add('hidden'); $('#pin-in').focus();
}
$('#pin-form').addEventListener('submit', e => {
  e.preventDefault(); const v = $('#pin-in').value, fail = m => { $('#pin-err').textContent = m; $('#pin-err').classList.remove('hidden'); };
  if (!sess.pin) {
    if (!/^\d{6}$/.test(v)) return fail('The PIN must be exactly 6 digits.');
    if (v !== $('#pin-in2').value) return fail('PINs don’t match.');
    sess.pin = v; store.set('acct', sess);
  } else {
    if (Date.now() < pinLock) return fail(`Too many attempts. Try again in ${Math.ceil((pinLock - Date.now()) / 1000)} seconds.`);
    if (v !== sess.pin) { $('#pin-in').value = ''; if (++pinFails >= 5) { pinFails = 0; pinLock = Date.now() + 30000; return fail('Too many attempts. Try again in 30 seconds.'); } return fail('Incorrect PIN.'); }
  }
  pinFails = 0; unlocked = true; go(pinTarget);
});

/* ---------- Reusable confirmation card (replaces native confirm()) ---------- */
const cfModal = $('#confirm-modal');
let cfResolve = null;
const CF_ICON = { danger: '!', warn: '?', ok: '✓' };
function confirmCard({ title = 'Are you sure?', msg = '', ok = 'Confirm', cancel = 'Cancel', tone = 'danger' } = {}) {
  if (cfResolve) closeConfirm(false); // settle any card still on screen so its await never hangs
  $('#cf-title').textContent = title;
  $('#cf-msg').textContent = msg;
  $('#cf-ok').textContent = ok;
  $('#cf-cancel').textContent = cancel;
  const ic = $('#cf-icon');
  ic.textContent = CF_ICON[tone] || CF_ICON.danger;
  ic.className = 'cf-icon mx-auto ' + (tone || 'danger');
  const okBtn = $('#cf-ok');
  okBtn.classList.toggle('cf-danger', tone === 'danger');
  cfModal.classList.remove('hidden'); cfModal.classList.add('flex');
  (tone === 'danger' ? $('#cf-cancel') : okBtn).focus();
  return new Promise(res => { cfResolve = res; });
}
function closeConfirm(v) {
  if (!cfModal || cfModal.classList.contains('hidden')) return;
  cfModal.classList.add('hidden'); cfModal.classList.remove('flex');
  if (cfResolve) { const r = cfResolve; cfResolve = null; r(v); }
}
$('#cf-cancel').addEventListener('click', () => closeConfirm(false));
$('#cf-ok').addEventListener('click', () => closeConfirm(true));
cfModal.addEventListener('click', e => { if (e.target === cfModal) closeConfirm(false); });
addEventListener('keydown', e => { if (e.key === 'Escape' && cfResolve) closeConfirm(false); });

/* Log out asks for the 6-digit PIN first, so staff at the station can't log the admin out */
const loModal = $('#logout-modal');
function openLogout() {
  if (!sess.pin) { sess = null; go('login'); return; } // older accounts with no PIN yet log out directly
  $('#lo-pin').value = ''; $('#lo-err').classList.add('hidden');
  loModal.classList.remove('hidden'); loModal.classList.add('flex'); $('#lo-pin').focus();
}
const closeLogout = () => { loModal.classList.add('hidden'); loModal.classList.remove('flex'); };
$('#lo-pin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('#logout').addEventListener('click', openLogout);
$('#home-out').addEventListener('click', openLogout);
$('#lo-x').addEventListener('click', closeLogout); $('#lo-cancel').addEventListener('click', closeLogout);
addEventListener('keydown', e => { if (e.key === 'Escape') closeLogout(); });
$('#lo-form').addEventListener('submit', e => {
  e.preventDefault(); const v = $('#lo-pin').value, fail = m => { $('#lo-err').textContent = m; $('#lo-err').classList.remove('hidden'); };
  if (Date.now() < pinLock) return fail(`Too many attempts. Try again in ${Math.ceil((pinLock - Date.now()) / 1000)} seconds.`);
  if (v !== sess.pin) { $('#lo-pin').value = ''; if (++pinFails >= 5) { pinFails = 0; pinLock = Date.now() + 30000; return fail('Too many attempts. Try again in 30 seconds.'); } return fail('Incorrect PIN.'); }
  pinFails = 0; closeLogout(); sess = null; go('login');
});
$('#switch').addEventListener('click', () => go('home'));

/* ---------- Camera ---------- */
function stopCam() {
  camToken++; cancelAnimationFrame(raf);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $$('video').forEach(v => { v.srcObject = null; v.classList.add('hidden'); });
  $('#qframe').classList.add('hidden');
}
async function cam(video, facing, msg, frame) {
  const my = ++camToken;
  msg.classList.remove('hidden'); msg.textContent = 'Requesting camera access…';
  if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = 'Camera isn’t supported in this browser or context. Use the manual option.'; return false; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    if (my !== camToken) { s.getTracks().forEach(t => t.stop()); return false; }
    stream = s; video.srcObject = s; await video.play();
    video.classList.remove('hidden'); frame.classList.remove('hidden'); msg.classList.add('hidden');
    return true;
  } catch (err) {
    msg.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access in your browser settings, then try again.'
      : 'Couldn’t start the camera (' + err.name + ').';
    return false;
  }
}

/* ---------- QR scan ---------- */
const canvas = document.createElement('canvas'), cx = canvas.getContext('2d', { willReadFrequently: true });
async function startScan() {
  $('#retry').classList.add('hidden');
  const ok = await cam($('#qv'), 'environment', $('#qmsg'), $('#qframe'));
  if (ok) tick(); else if (!$('#qmsg').classList.contains('hidden')) $('#retry').classList.remove('hidden');
}
$('#retry').addEventListener('click', startScan);

function tick() {
  const v = $('#qv');
  if (v.readyState === v.HAVE_ENOUGH_DATA) {
    const s = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * s); canvas.height = Math.round(v.videoHeight * s);
    cx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const d = cx.getImageData(0, 0, canvas.width, canvas.height);
    const r = jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
    if (r && r.data) handleCode(r.data.trim());
  }
  raf = requestAnimationFrame(tick);
}
function handleCode(code) {
  const now = Date.now();
  if (code === lastScan.c && now - lastScan.t < 3000) return; // ignore repeat reads
  lastScan = { c: code, t: now };
  if (!EMP[code]) { toast('Unrecognized staff ID.', 'err'); return; }
  if (EMP[code].draft) { toast(EMP[code].name + '’s setup isn’t complete yet. Ask your manager.', 'err'); return; }
  if (!EMP[code].active) { toast(EMP[code].name + ' is inactive.', 'err'); return; }
  const sc = getSched(code, new Date()); // no shift today (day off / leave): block time in, but still allow time out for someone already clocked in
  if (sc.in == null && nextType(code) === 'in') { toast(`${EMP[code].name} isn’t scheduled today (${TYPE_LABEL[sc.t]}). Ask your manager to update the schedule.`, 'err'); return; }
  const today = new Date().toDateString(); // max 4 scans a day: time in, break out, break in, time out
  if (logs().filter(x => x.id === code && new Date(x.ts).toDateString() === today).length >= 4) { toast(EMP[code].name + ' has already completed all 4 scans today.', 'err'); return; }
  pending = code; go('verify');
}
$('#manual').addEventListener('submit', e => { e.preventDefault(); handleCode($('#mid').value.trim().toUpperCase()); $('#mid').value = ''; });

/* ---------- Verify & confirm ---------- */
const logs = () => store.get('logs', []);
const nextType = id => { const l = logs().filter(x => x.id === id).pop(); return l && l.type === 'in' ? 'out' : 'in'; };

function startVerify() { // QR scan -> confirm (no face step)
  const e = EMP[pending], type = nextType(pending), label = type === 'in' ? 'time in' : 'time out';
  $('#av').innerHTML = e.photo ? `<img src="${e.photo}" alt="" class="w-full h-full object-cover">` : esc(initials(e.name)); // photo helps the admin check who is at the station
  $('#en').textContent = e.name; $('#ei').textContent = pending;
  $('#ep').textContent = e.pos; $('#es').textContent = schedText(pending);
  $('#vt').textContent = 'Confirm attendance'; $('#vs').textContent = `QR code scanned. Confirm to record your ${label}.`;
  $('#vbtn').textContent = `Confirm ${label}`;
  const lw = $('#late-wrap');
  if (lw) {
    const today = new Date().toDateString();
    const firstIn = type === 'in' && !logs().some(x => x.id === pending && x.type === 'in' && new Date(x.ts).toDateString() === today);
    const late = firstIn && isLateNow(pending); // only the day's first time in can be late (break-in never asks)
    $('#late-note').value = '';
    if (late) $('#late-msg').textContent = `You are ${late} min late (scheduled ${fmtMin(startOf(pending))}, ${GRACE}-min grace included).`;
    lw.classList.toggle('hidden', !late);
  }
}
$('#vbtn').addEventListener('click', async () => {
  const type = nextType(pending), e = EMP[pending], now = Date.now();
  const today = new Date().toDateString();
  const firstIn = type === 'in' && !logs().some(x => x.id === pending && x.type === 'in' && new Date(x.ts).toDateString() === today);
  const late = firstIn && isLateNow(pending, now);
  const noteEl = $('#late-note');
  const note = late && noteEl ? noteEl.value.trim().replace(/\s+/g, ' ').slice(0, 140) : ''; // keep one line, cap length
  const ok = await confirmCard({
    title: type === 'in' ? 'Confirm time in?' : 'Confirm time out?',
    msg: `${e.name} (${pending}): record ${type === 'in' ? 'time in' : 'time out'} at ${fmtTime(now)}${late ? ` — ${late} min late` : ''}?`,
    ok: type === 'in' ? 'Confirm time in' : 'Confirm time out', tone: 'ok',
  });
  if (!ok) return;
  const l = logs(); l.push({ id: pending, name: e.name, type, ts: now, ...(note ? { note } : {}) }); store.set('logs', l);
  toast(`${e.name}: Time ${type} at ${fmtTime(now)}` + (note ? ' — reason saved.' : ''));
  pending = null; go('scan');
});

/* ---------- Dashboard ---------- */
function lateNotifs() { // today's late time-ins, newest first — employee reasons ride along on the log entry
  const today = new Date().toDateString(), t = logs().filter(x => new Date(x.ts).toDateString() === today);
  const seen = new Set();
  return t.filter(x => x.type === 'in' && EMP[x.id] && EMP[x.id].active && !seen.has(x.id) && seen.add(x.id))
    .map(x => {
      const d = new Date(x.ts), m = d.getHours() * 60 + d.getMinutes(), s = startOf(x.id);
      return m > s + GRACE ? { ...x, mins: m - s, sin: s } : null;
    }).filter(Boolean).sort((a, b) => b.ts - a.ts);
}
function renderBell() {
  const panel = $('#bell-panel'); if (!panel) return;
  const items = lateNotifs();
  $('#bell-dot').classList.toggle('hidden', !items.length);
  panel.innerHTML = items.length ? `<div class="w-full text-left space-y-2 max-h-80 overflow-auto">`
    + `<p class="text-sm font-medium px-1">Late arrivals today (${items.length})</p>`
    + items.map(x => `<div class="card p-3"><div class="text-sm font-medium">${esc(x.name)} <span class="muted font-normal">· ${x.id}</span></div>`
      + `<div class="muted text-xs mt-0.5">${fmtTime(x.ts)} · Scheduled ${fmtMin(x.sin)} · Late by ${x.mins} min</div>`
      + `<div class="text-sm mt-1">${x.note ? `“${esc(x.note)}”` : '<span class="muted">No reason given.</span>'}</div></div>`).join('')
    + `</div>` : '<p class="muted text-sm">No notifications</p>';
}
function renderDash() {
  $('#d-biz').textContent = sess.business; $('#d-av').textContent = initials(sess.name);
  $('#d-hi').textContent = 'Hello, ' + sess.name.split(' ')[0] + '!';
  const today = new Date().toDateString();
  const t = logs().filter(x => new Date(x.ts).toDateString() === today);
  const present = [...new Set(t.filter(x => x.type === 'in' && EMP[x.id] && EMP[x.id].active).map(x => x.id))];
  const late = present.filter(id => {
    const d = new Date(t.find(x => x.id === id && x.type === 'in').ts);
    return d.getHours() * 60 + d.getMinutes() > startOf(id) + GRACE; // 15-min grace after scheduled start
  }).length;
  const total = activeIds().length;
  const absent = activeIds().filter(id => startOf(id) < 1e8 && !present.includes(id)).length;
  renderChart([present.length - late, late, absent]);
  $('#stats').innerHTML = [['Active staff', total], ['Present today', present.length], ['Absent today', absent], ['Late today', late]]
    .map(([l, n]) => `<div class="card p-4"><div class="text-2xl font-semibold">${n}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
  const BADGE = { present: ['b-ok', 'Present'], late: ['b-warn', 'Late'], absent: ['b-err', 'Absent'], off: ['b-muted', 'Day off'] };
  $('#rows').innerHTML = Object.entries(EMP).filter(([, e]) => e.active).map(([id, e]) => {
    const f = t.find(x => x.id === id && x.type === 'in'); // first time in today
    const d = f && new Date(f.ts);
    const st = !f ? (startOf(id) > 1e8 ? 'off' : 'absent') : d.getHours() * 60 + d.getMinutes() > startOf(id) + GRACE ? 'late' : 'present';
    return `<tr class="border-t hair"><td class="py-2">${id}</td><td>${esc(e.name)}${st === 'late' && f.note ? `<div class="muted text-xs" style="max-width:12rem">“${esc(f.note)}”</div>` : ''}</td><td>${f ? fmtTime(f.ts) : '—'}</td><td><span class="badge ${BADGE[st][0]}">${BADGE[st][1]}</span></td></tr>`;
  }).join('');
  $('#stat-late').textContent = late;
  renderBell(); // keep the bell dot in step with today's late arrivals
}
$('#bell').addEventListener('click', e => {
  e.stopPropagation();
  const panel = $('#bell-panel');
  if (panel.classList.contains('hidden')) renderBell(); // fresh late list + reasons each time it opens
  panel.classList.toggle('hidden');
  $('#bell').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
});
document.addEventListener('click', e => {
  const panel = $('#bell-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  if (e.target.closest('#bell-panel') || e.target.closest('#bell')) return;
  panel.classList.add('hidden');
  $('#bell').setAttribute('aria-expanded', 'false');
});
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const panel = $('#bell-panel');
  if (panel && !panel.classList.contains('hidden')) { panel.classList.add('hidden'); $('#bell').setAttribute('aria-expanded', 'false'); }
});

/* Slide the stacked bars up from the baseline on every render (SVG transform attribute, so it works in every browser) */
function riseBars(bars) {
  if (!bars.length) return;
  const DUR = 700, STAGGER = 55, DIST = 220, reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  bars.forEach(g => { g.setAttribute('transform', reduce ? 'translate(0 0)' : `translate(0 ${DIST})`); g.style.opacity = reduce ? '1' : '0'; }); // wait below the baseline, so there is no flash before the first frame
  if (reduce) return; // motion off: show them resting in place
  const ease = t => 1 - Math.pow(1 - t, 3), t0 = performance.now();
  const frame = now => {
    let running = false;
    bars.forEach((g, i) => {
      const t = (now - t0 - i * STAGGER) / DUR, k = t <= 0 ? 0 : t >= 1 ? 1 : t, e = ease(k);
      g.setAttribute('transform', `translate(0 ${(DIST * (1 - e)).toFixed(2)})`); // rises from below to its resting spot
      g.style.opacity = e.toFixed(3);
      if (k < 1) running = true;
    });
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ---------- Chart: last 7 days, stacked bars (inline SVG, no library) ---------- */
function renderChart(todayData) {
  const total = Math.max(15, activeIds().length), data = [...HIST, todayData], days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toLocaleDateString('en-US', { weekday: 'short' })); }
  const W = 420, H = 190, pl = 28, pb = 24, pt = 8, bw = 42, gap = (W - pl - 7 * bw) / 7, sy = v => (H - pb - pt) * v / total;
  let s = '<defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".18"/></linearGradient></defs>'; // each bar fades toward the baseline
  Array.from({ length: Math.floor(total / 5) + 1 }, (_, k) => k * 5).forEach(v => { const y = H - pb - sy(v); s += `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`; });
  data.forEach(([p, l, a], i) => {
    const x = pl + gap / 2 + i * (bw + gap); let y = H - pb;
    const tot = sy(p + l + a);
    s += `<mask id="fm${i}"><rect x="${x}" y="${H - pb - tot}" width="${bw}" height="${tot}" fill="url(#fg)"/></mask><g><title>${days[i]}: ${p} on time, ${l} late, ${a} absent</title><g class="bar-anim"><g mask="url(#fm${i})">`;
    [[p, 'var(--brand)'], [l, 'var(--gold)'], [a, 'var(--err)']].forEach(([v, c]) => { const h = sy(v); y -= h; s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${c}" rx="3"/>`; });
    s += '</g></g>';
    s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${days[i]}</text></g>`;
  });
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="Attendance over the last 7 days">${s}</svg>`;
  riseBars($$('#chart .bar-anim')); // freshly built bars, so the rise replays every time the dashboard renders
}
$('#reset').addEventListener('click', async () => {
  const ok = await confirmCard({
    title: 'Reset demo data?',
    msg: 'This restores the sample staff, schedules, attendance logs, payroll and deductions, and removes anything you changed. This can’t be undone.',
    ok: 'Reset all data', tone: 'danger',
  });
  if (!ok) return;
  Object.keys(SCH).forEach(k => delete SCH[k]); saveSch();
  Object.keys(EMP).forEach(k => delete EMP[k]); Object.assign(EMP, defaultEmps()); saveEmps();
  resetPay(); pSel.clear(); hSel = null;
  store.set('logs', seedLogs()); resetDedTypes(); DED.length = 0; DED.push(...seedDeds()); saveDed(); route(); toast('Demo data reset.');
});

/* ---------- Demo QR codes ---------- */
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(); let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" class="w-full" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function renderQR() {
  const g = $('#qr-grid');
  if (typeof qrcode === 'undefined') { g.innerHTML = '<p class="muted text-sm col-span-full">The QR library didn’t load. Check your internet connection.</p>'; return; }
  g.innerHTML = Object.entries(EMP).filter(([, e]) => e.active).map(([id, e]) => `<div class="card p-3 text-center"><div class="max-w-[9rem] mx-auto">${qrSvg(id)}</div><div class="font-medium text-sm mt-2">${esc(e.name)}</div><div class="muted text-xs">${id}</div></div>`).join('');
}

/* ---------- Staff page ---------- */
const fmtDate = s => new Date(s + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
$('#f-shift').innerHTML = SHIFTS.map((s, i) => `<option value="${i}">${s[1]}</option>`).join('');

const eSel = new Set(), cardOk = id => !!EMP[id] && EMP[id].active && !EMP[id].draft; // ID cards: active staff with completed setup
function renderStaff() {
  const all = Object.entries(EMP), act = all.filter(([, e]) => e.active).length, dr = all.filter(([, e]) => e.draft).length;
  $('#emp-stats').innerHTML = [['Total staff', all.length], ['Active staff', act], ['Inactive staff', all.length - act - dr], ['Draft staff', dr]]
    .map(([l, n]) => `<div class="card p-4"><div class="text-2xl font-semibold">${n}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
  const q = $('#e-q').value.trim().toLowerCase(), pf = $('#e-pos').value, sf = $('#e-st').value;
  const rows = all.filter(([id, e]) => (!q || `${id} ${e.name} ${e.pos}`.toLowerCase().includes(q)) && (!pf || e.pos === pf) && (!sf || (e.draft ? 'draft' : e.active ? 'active' : 'inactive') === sf));
  $('#emp-rows').innerHTML = rows.length ? rows.map(([id, e], i) => `<tr class="border-t hair">
    <td class="py-2.5 pr-3"><input type="checkbox" data-csel="${id}" ${eSel.has(id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></td><td class="py-2.5 muted">${i + 1}</td>
    <td class="whitespace-nowrap">${e.photo ? `<img class="avatar mr-2 align-middle inline-block" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs mr-2 align-middle" style="background:var(--bg)">${initials(e.name)}</span>`}${id}</td>
    <td>${esc(e.name)}</td><td>${esc(e.pos)}</td><td class="whitespace-nowrap">${e.rate > 0 ? num(e.rate) : '—'}</td><td class="whitespace-nowrap">${esc(e.contact || '—')}</td><td class="whitespace-nowrap">${fmtDate(e.hired)}</td>
    <td><span class="badge ${e.draft ? 'b-warn' : e.active ? 'b-ok' : 'b-err'}">${e.draft ? 'Draft' : e.active ? 'Active' : 'Inactive'}</span></td>
    <td class="whitespace-nowrap"><button class="ghost !py-1 !px-2 text-xs" data-card="${id}" ${cardOk(id) ? '' : 'disabled title="Activate the staff to issue an ID card"'}>ID card</button> <button class="ghost !py-1 !px-2 text-xs" data-edit="${id}">Edit</button> <button class="ghost !py-1 !px-2 text-xs" style="color:var(--err)" data-del="${id}">Delete</button></td></tr>`).join('')
    : '<tr class="border-t hair"><td colspan="10" class="py-8 text-center muted">No staff match your filters.</td></tr>';
  $('#emp-count').textContent = `Showing ${rows.length} of ${all.length} staff`;
  $('#e-all').checked = rows.length > 0 && rows.every(([id]) => eSel.has(id));
}
$('#e-pos').innerHTML = '<option value="">All positions</option>' + POSITIONS.map(p => `<option value="${p}">${p}</option>`).join(''); // only Kitchen Staff and Dine Staff
['#e-q', '#e-pos', '#e-st'].forEach(s => $(s).addEventListener('input', renderStaff));

/* ---------- Add / edit staff wizard ---------- */
const LABELS = { 1: 'Continue to Review →', 2: 'Generate ID & save' };
const modal = $('#emp-modal');
let editId = null, W = null;
const nextEmpId = () => 'STF-' + pad(Math.max(0, ...Object.keys(EMP).map(k => +k.slice(4))) + 1);
const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });

function paintPhoto() {
  $('#p-prev').innerHTML = W.photo ? `<img src="${W.photo}" alt="Staff photo">` : 'No photo';
  $('#p-rm').disabled = !W.photo;
}

function setWiz(n) {
  stopCam(); W.step = n;
  $$('#emp-form [data-step]').forEach(s => s.classList.toggle('hidden', +s.dataset.step !== n));
  $$('#emp-form [data-dot]').forEach(d => { const k = +d.dataset.dot; d.classList.toggle('on', k <= n); d.textContent = k < n ? '✓' : k; });
  $$('#emp-form [data-lbl]').forEach(l => l.style.color = +l.dataset.lbl === n ? 'var(--text)' : '');
  $('#emp-sub').textContent = ['Fill in the details below to add a new staff.', 'Check everything, then generate the staff ID.'][n - 1];
  $('#f-back').classList.toggle('hidden', n === 1);
  $('#f-next').textContent = LABELS[n];
  if (n === 2) {
    $('#f-sum').innerHTML = [['Staff ID', W.id], ['Name', W.name], ['Position', W.pos], ['Rate per hour', peso(W.rate)], ['Contact number', W.contact], ['Date hired', fmtDate(W.hired)]]
      .map(([k, v]) => `<div class="flex justify-between border-b hair pb-2"><dt class="muted">${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#f-idbig').textContent = W.id;
    $('#f-qr').innerHTML = typeof qrcode === 'undefined' ? '' : qrSvg(W.id);
  }
}

function readStep1() {
  const v = { name: $('#f-name').value.trim(), pos: $('#f-pos').value, rate: parseFloat($('#f-rate').value), hired: $('#f-hired').value, contact: fmtPhone($('#f-contact').value) };
  if (!v.name || !v.pos || !(v.rate > 0) || !v.hired) { toast('Enter the name, position, rate and date hired.', 'err'); return false; }
  if (!v.contact) { toast('Enter a valid mobile number, for example 0917 123 4567.', 'err'); return false; }
  Object.assign(W, v); return true;
}

function openEmp(id) {
  editId = id || null;
  const e = id ? EMP[id] : { name: '', pos: '', rate: '', hired: dkey(new Date()), shift: 0, active: true, contact: '', photo: '' };
  W = { step: 1, id: id || nextEmpId(), photo: e.photo || '' };
  const opts = [...new Set([...POSITIONS, ...(e.pos ? [e.pos] : [])])];
  $('#f-pos').innerHTML = '<option value="">Select position</option>' + opts.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#emp-title').textContent = id ? `Edit ${id}` : 'Add Staff';
  $('#f-id').value = W.id; $('#f-name').value = e.name; $('#f-pos').value = e.pos; $('#f-rate').value = e.rate;
  $('#f-hired').value = e.hired; $('#f-shift').value = e.shift; $('#f-contact').value = e.contact || '';
  paintPhoto(); setWiz(1);
  modal.classList.remove('hidden'); modal.classList.add('flex'); $('#f-name').focus();
}
function closeEmp() { stopCam(); modal.classList.add('hidden'); modal.classList.remove('flex'); }

function saveEmp(draft) {
  if (!readStep1()) { if (W.step !== 1) setWiz(1); return; }
  const old = EMP[W.id] || {};
  EMP[W.id] = withShift({
    name: W.name, pos: W.pos, rate: W.rate, hired: W.hired, photo: W.photo, draft,
    contact: W.contact, shift: +$('#f-shift').value,
    active: draft ? false : (editId ? old.active !== false || old.draft === true : true),
  });
  saveEmps(); closeEmp(); renderStaff();
  toast(draft ? `Draft saved as ${W.id}.` : editId ? 'Staff updated.' : `Staff added as ${W.id}.`);
}

$('#add-emp').addEventListener('click', () => openEmp());
$('#f-x').addEventListener('click', closeEmp);
addEventListener('keydown', e => { if (e.key === 'Escape') closeEmp(); });
$('#f-back').addEventListener('click', () => setWiz(W.step - 1));
$('#f-draft').addEventListener('click', () => saveEmp(true));
$('#f-next').addEventListener('click', () => {
  if (W.step === 1) { if (readStep1()) setWiz(2); }
  else saveEmp(false);
});
$('#p-up').addEventListener('click', () => $('#f-file').click());
$('#p-rm').addEventListener('click', () => { W.photo = ''; paintPhoto(); });
$('#f-file').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!/^image\/(png|jpeg)$/.test(f.type)) return toast('Use a JPG or PNG image.', 'err');
  if (f.size > 2 * 1024 * 1024) return toast('Photo must be 2MB or smaller.', 'err');
  const img = new Image();
  img.onload = () => { W.photo = squareThumb(img, img.width, img.height); URL.revokeObjectURL(img.src); paintPhoto(); };
  img.src = URL.createObjectURL(f);
});
function squareThumb(src, w, h) { // 256px square JPEG keeps localStorage small
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const s = Math.min(w, h);
  c.getContext('2d').drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 256, 256);
  return c.toDataURL('image/jpeg', .8);
}

$('#emp-rows').addEventListener('click', async e => {
  const k = e.target.closest('[data-csel]'); if (k) { k.checked ? eSel.add(k.dataset.csel) : eSel.delete(k.dataset.csel); return; }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.card) { if (!b.disabled) openCard(b.dataset.card); return; }
  if (b.dataset.edit) EMP[b.dataset.edit].draft ? openEmp(b.dataset.edit) : openEdit(b.dataset.edit); // drafts resume setup; existing staff get the edit form
  if (b.dataset.del) {
    const id = b.dataset.del, e = EMP[id];
    if (!e) return;
    const ok = await confirmCard({ title: 'Delete staff?', msg: `Delete ${e.name} (${id})? Attendance, schedules and payroll history for this staff will be removed. This can’t be undone.`, ok: 'Delete', tone: 'danger' });
    if (ok) { delete EMP[id]; eSel.delete(id); saveEmps(); renderStaff(); toast('Staff deleted.'); }
    return;
  }
});
/* ---------- Edit existing staff (ID, hire date and face registration are read-only) ---------- */
const eModal = $('#edit-modal');
let xId = null, xPhoto = '';
function paintX() {
  $('#x-prev').innerHTML = xPhoto ? `<img src="${xPhoto}" alt="Staff photo" class="w-full h-full object-cover">` : esc(initials(EMP[xId].name));
  $('#x-rm').disabled = !xPhoto;
}
function openEdit(id) {
  xId = id; const e = EMP[id]; xPhoto = e.photo || '';
  $('#x-info').innerHTML = [['Staff ID', id], ['Date hired', fmtDate(e.hired)]]
    .map(([k, v]) => `<div><dt class="muted text-xs">${k}</dt><dd class="mt-0.5">${esc(v)}</dd></div>`).join('');
  const opts = [...new Set([...POSITIONS, e.pos])];
  $('#x-pos').innerHTML = opts.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#x-name').value = e.name; $('#x-pos').value = e.pos; $('#x-rate').value = e.rate || '';
  $('#x-contact').value = e.contact || ''; $('#x-status').value = e.active ? 'active' : 'inactive';
  paintX(); eModal.classList.remove('hidden'); eModal.classList.add('flex'); $('#x-name').focus();
}
const closeEdit = () => { eModal.classList.add('hidden'); eModal.classList.remove('flex'); };
$('#x-x').addEventListener('click', closeEdit);
$('#x-cancel').addEventListener('click', closeEdit);
addEventListener('keydown', e => { if (e.key === 'Escape') closeEdit(); });
$('#x-up').addEventListener('click', () => $('#x-file').click());
$('#x-rm').addEventListener('click', () => { xPhoto = ''; paintX(); });
$('#x-file').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!/^image\/(png|jpeg)$/.test(f.type)) return toast('Use a JPG or PNG image.', 'err');
  if (f.size > 2 * 1024 * 1024) return toast('Photo must be 2MB or smaller.', 'err');
  const img = new Image();
  img.onload = () => { xPhoto = squareThumb(img, img.width, img.height); URL.revokeObjectURL(img.src); paintX(); };
  img.src = URL.createObjectURL(f);
});
$('#x-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#x-name').value.trim(), rate = parseFloat($('#x-rate').value);
  if (!name || !(rate > 0)) { toast('Enter the name and a rate per hour.', 'err'); return; }
  const ph = fmtPhone($('#x-contact').value); if (!ph) { toast('Enter a valid mobile number, for example 0917 123 4567.', 'err'); return; }
  EMP[xId] = withShift({
    ...EMP[xId], name, pos: $('#x-pos').value, rate, contact: ph,
    active: $('#x-status').value === 'active', photo: xPhoto
  });
  saveEmps(); closeEdit(); renderStaff(); toast('Staff updated.');
});

/* ---------- ID cards ---------- */
const bizName = () => (typeof sess !== 'undefined' && sess && sess.business) || 'InfusoPay';
const cardFront = id => {
  const e = EMP[id]; return `<div class="idc"><div class="idc-h">${esc(bizName())}</div><div class="idc-b">
  <div class="idc-p">${e.photo ? `<img src="${e.photo}" alt="">` : esc(initials(e.name))}</div>
  <div class="idc-t"><div class="idc-n">${esc(e.name)}</div><div class="idc-s">${esc(e.pos)}</div><div class="idc-i">${id}</div></div>
  <div class="idc-q">${typeof qrcode === 'undefined' ? '' : qrSvg(id)}</div></div>
  <div class="idc-f"><span>Staff ID card</span><span>Scan for attendance</span></div></div>`;
};
const cardBack = id => `<div class="idc"><div class="idc-h">${esc(bizName())}</div><div class="idc-bk">
  <p>This card is the property of ${esc(bizName())}. It is non-transferable and must be shown when requested.</p>
  <p>Scan the QR code at the attendance station to record your time in and out.</p>
  <p>If found, please return it to ${esc(bizName())}, Bulacan.</p></div><div class="idc-f"><span>${id}</span><span>Report a lost card to your manager</span></div></div>`;
const cardModal = $('#card-modal'); let cardId = null;
function openCard(id) { cardId = id; $('#cm-body').innerHTML = cardFront(id) + cardBack(id); cardModal.classList.remove('hidden'); cardModal.classList.add('flex'); }
const closeCard = () => { cardModal.classList.add('hidden'); cardModal.classList.remove('flex'); };
function printCards(ids) {
  const ok = ids.filter(cardOk);
  if (!ok.length) { toast('ID cards are only issued to active staff with completed setup.', 'err'); return; }
  if (ok.length < ids.length) toast(`Skipped ${ids.length - ok.length} inactive or draft staff${ids.length - ok.length === 1 ? '' : 's'}.`, 'err');
  $('#card-sheet').innerHTML = ok.map(id => cardFront(id) + cardBack(id)).join('');
  window.print();
}
addEventListener('afterprint', () => { $('#card-sheet').innerHTML = ''; });
$('#cm-x').addEventListener('click', closeCard); $('#cm-close').addEventListener('click', closeCard);
addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });
$('#cm-print').addEventListener('click', () => printCards([cardId]));
$('#print-cards').addEventListener('click', () => eSel.size ? printCards([...eSel]) : toast('Select staff first.', 'err'));
$('#e-all').addEventListener('change', e => { $$('#emp-rows [data-csel]').forEach(k => { k.checked = e.target.checked; e.target.checked ? eSel.add(k.dataset.csel) : eSel.delete(k.dataset.csel); }); });

/* ---------- Schedules: page ---------- */
const mondayOf = d => { const m = new Date(d); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toTime = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
let wk = mondayOf(new Date()), sEdit = null;

const YMD = { month: 'short', day: 'numeric', year: 'numeric' };
function renderSchedule() {
  const days = [...Array(7)].map((_, i) => addDays(wk, i)), a = days[0], b = days[6], todayK = dkey(new Date()), t0 = new Date(new Date().setHours(0, 0, 0, 0));
  $('#s-range').textContent = a.getFullYear() !== b.getFullYear()
    ? `${a.toLocaleDateString('en-US', YMD)} – ${b.toLocaleDateString('en-US', YMD)}`
    : a.getMonth() === b.getMonth()
      ? `${a.toLocaleDateString('en-US', { month: 'long' })} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`
      : `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`;
  const staff = Object.entries(EMP).filter(([, e]) => e.active && !e.draft);
  const q = $('#s-q').value.trim().toLowerCase(), pf = $('#s-pos').value;
  const rows = staff.filter(([id, e]) => (!q || `${id} ${e.name}`.toLowerCase().includes(q)) && (!pf || e.pos === pf));
  $('#s-head').innerHTML = '<tr><th class="text-left font-normal muted py-2 sticky left-0 z-10" style="background:var(--surface)">Staff</th>' + days.map(d => {
    const t = dkey(d) === todayK;
    return `<th class="font-normal text-center py-1"><div class="${t ? 'font-medium' : 'muted'}">${d.toLocaleDateString('en-US', { weekday: 'short' })}</div><div class="text-xs mt-0.5 ${t ? 'inline-grid place-items-center w-6 h-6 rounded-full' : 'muted'}" ${t ? 'style="background:var(--accent);color:var(--ink)"' : ''}>${d.getDate()}</div></th>`;
  }).join('') + '</tr>';
  $('#s-rows').innerHTML = rows.length ? rows.map(([id, e]) => `<tr><td class="sticky left-0 z-10 pr-3 py-1 whitespace-nowrap" style="background:var(--surface)">
    <div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}
    <div class="leading-tight"><div class="font-medium">${esc(e.name)}</div><div class="muted text-xs">${esc(e.pos)}</div></div></div></td>` + days.map(d => {
    const s = getSched(id, d), past = d < t0;
    if (d < new Date(e.hired + 'T00:00')) return '<td class="p-0 align-top min-w-[112px]"><div class="sc muted" style="background:transparent;border-left-color:transparent">Not yet hired</div></td>';
    return `<td class="p-0 align-top min-w-[112px]"><button type="button" class="sc sc-${s.in != null ? 'work' : 'off'}${past ? ' sc-lock' : ''}" ${past ? 'disabled title="Past schedules can’t be edited"' : ''} data-id="${id}" data-d="${dkey(d)}"><b>${s.in != null ? 'Scheduled' : 'Day off'}</b>${s.in != null ? `<span class="muted">${fmtShort(s.in)} – ${fmtShort(s.out)}</span>` : ''}</button></td>`;
  }).join('') + '</tr>').join('') : '<tr><td colspan="8" class="py-8 text-center muted">No staff match your filters.</td></tr>';
}
$('#s-prev').addEventListener('click', () => { wk = addDays(wk, -7); renderSchedule(); });
$('#s-next').addEventListener('click', () => { wk = addDays(wk, 7); renderSchedule(); });
$('#s-today').addEventListener('click', () => { wk = mondayOf(new Date()); renderSchedule(); });
$('#s-pos').innerHTML = '<option value="">All positions</option>' + POSITIONS.map(p => `<option value="${p}">${p}</option>`).join(''); // only Kitchen Staff and Dine Staff
['#s-q', '#s-pos'].forEach(s => $(s).addEventListener('input', renderSchedule));

const sModal = $('#sch-modal');
const paintWork = () => $('#s-work').classList.toggle('hidden', $('#s-status').value !== 'work');
function openSch(id, key) {
  if (key < dkey(new Date())) { toast('Past schedules can’t be edited.', 'err'); return; }
  const d = new Date(key + 'T00:00'), s = getSched(id, d), e = EMP[id];
  sEdit = { id, key };
  $('#s-info').innerHTML = [['Staff', esc(e.name)], ['Date', d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })]]
    .map(([k, v]) => `<div class="flex justify-between"><dt class="muted">${k}</dt><dd>${v}</dd></div>`).join('');
  const p = SHIFT_TYPES[TYPE_BY_SHIFT[e.shift] || 'morning']; // default times come from the staff's default shift
  $('#s-status').value = s.in != null ? 'work' : 'off';
  $('#s-in').value = toTime(s.in ?? p.in); $('#s-out').value = toTime(s.out ?? p.out);
  paintWork(); sModal.classList.remove('hidden'); sModal.classList.add('flex');
}
const closeSch = () => { sModal.classList.add('hidden'); sModal.classList.remove('flex'); };
$('#s-rows').addEventListener('click', e => { const b = e.target.closest('.sc'); if (b) openSch(b.dataset.id, b.dataset.d); });
$('#s-status').addEventListener('change', paintWork);
$('#s-x').addEventListener('click', closeSch); $('#s-cancel').addEventListener('click', closeSch);
addEventListener('keydown', e => { if (e.key === 'Escape') closeSch(); });
$('#s-form').addEventListener('submit', e => {
  e.preventDefault();
  const st = $('#s-status').value; let v;
  if (sEdit.key < dkey(new Date())) { toast('Past schedules can’t be edited.', 'err'); return; }
  if (st === 'off' && sEdit.key === dkey(new Date()) && logs().some(x => x.id === sEdit.id && dkey(new Date(x.ts)) === sEdit.key)) { toast(`${EMP[sEdit.id].name} already scanned in today, so today can’t be set as a day off.`, 'err'); return; }
  if (st === 'work') {
    if (!$('#s-in').value || !$('#s-out').value) { toast('Enter the time in and time out.', 'err'); return; }
    const i = toMin($('#s-in').value); let o = toMin($('#s-out').value); if (o <= i) o += 1440; // ends after midnight
    v = { t: i >= 840 ? 'night' : i >= 570 ? 'afternoon' : 'morning', in: i, out: o }; // internal shift type, derived from the start time
  } else v = { t: st };
  (SCH[sEdit.key] = SCH[sEdit.key] || {})[sEdit.id] = v; saveSch(); closeSch(); renderSchedule(); toast(sEdit.key === dkey(new Date()) ? 'Schedule updated. Today’s attendance now follows it.' : 'Schedule updated.');
});

/* ---------- Attendance records ---------- */
const PER_PAGE = 10;
let aMode = 'today', aPage = 1;
const hsh = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const fmtHM = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h${mm ? ' ' + String(mm).padStart(2, '0') + 'm' : ''}` : mm ? mm + 'm' : '0h'; };
const schedShort = s => `${fmtShort(s.in).replace(' ', '')}–${fmtShort(s.out).replace(' ', '')}`;
const ATT_BADGE = { present: ['b-ok', 'Present'], late: ['b-warn', 'Late'], absent: ['b-err', 'Absent'], upcoming: ['b-muted', 'Upcoming'], off: ['b-muted', 'Day off'], leave: ['b-muted', 'On leave'] };
const minOf = t => { const q = new Date(t); return q.getHours() * 60 + q.getMinutes(); };

function attRecord(id, d) { // up to 4 scans a day: time in, break out, break in, time out
  const key = dkey(d), s = getSched(id, d), isToday = key === dkey(new Date()), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const r = { id, e: EMP[id], d, s, t: [], tin: null, tout: null, running: false, onBreak: false, hrs: 0, note: '' };
  if (s.in == null) return { ...r, st: s.t };
  if (isToday) {
    const day = logs().filter(x => x.id === id && dkey(new Date(x.ts)) === key).slice(0, 4);
    r.t = day.map(x => minOf(x.ts));
    r.note = (day.find(x => x.type === 'in') || {}).note || ''; // late reason typed on Confirm Attendance
  }
  else if (hsh(id + key) % 100 >= 7) { // demo history: deterministic, so the same day always shows the same record
    const tin = s.in + (hsh(key + id) % 35) - 12, tout = s.out + (hsh(id + 'o' + key) % 30) - 12;
    const bo = Math.round((s.in + s.out) / 2) + (hsh(id + 'b' + key) % 21) - 10, bi = bo + 50 + (hsh(key + 'i' + id) % 21); // break of 50–70 min around mid-shift
    r.t = [tin, bo, bi, tout];
  }
  if (!r.t.length) return { ...r, st: isToday && nowMin < s.in ? 'upcoming' : 'absent' };
  for (let i = 1; i < r.t.length; i++) if (r.t[i] < r.t[i - 1]) r.t[i] += 1440; // scan after midnight
  const n = r.t.length;
  r.tin = r.t[0]; r.tout = n >= 4 ? r.t[3] : null; // final time out only counts once all 4 scans are in (2 scans = on break, not gone home)
  r.running = isToday && n % 2 === 1; r.onBreak = isToday && n === 2;
  for (let i = 0; i < n; i += 2) { // hours worked = time in → time out for each half, so the break is excluded
    const st = r.t[i]; let en = r.t[i + 1];
    if (en == null) { en = nowMin; if (en < st) en += 1440; }
    r.hrs += Math.max(0, en - st);
  }
  r.st = r.tin > s.in + GRACE ? 'late' : 'present';
  return r;
}
function attDates() {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return aMode === 'date' && $('#a-date').value ? [new Date($('#a-date').value + 'T00:00')] : [t];
}
const A_COLS = [['ID'], ['Staff'], ['Scheduled'], ['Time In', 'Shift start'], ['Time Out', 'Break start'], ['Time In', 'Break end'], ['Time Out', 'Shift end'], ['Hours Worked'], ['Status']];
$('#a-pos').innerHTML = '<option value="">All Positions</option>' + POSITIONS.map(p => `<option value="${p}">${p}</option>`).join(''); // only Kitchen Staff and Dine Staff
function renderAttendance() {
  const todayK = dkey(new Date());
  if (aMode !== 'date') $('#a-date').value = ''; $('#a-date').max = todayK;
  $$('#a-modes button').forEach(b => b.className = b.dataset.mode === aMode ? 'btn text-sm' : 'ghost text-sm');
  const staff = Object.entries(EMP).filter(([, e]) => e.active && !e.draft);
  const q = $('#a-q').value.trim().toLowerCase(), pf = $('#a-pos').value, sf = $('#a-st').value, dates = attDates();
  $('#a-label').textContent = dates[0].toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const recs = [];
  dates.forEach(d => staff.forEach(([id, e]) => {
    if (d < new Date(e.hired + 'T00:00') || (pf && e.pos !== pf) || (q && !`${id} ${e.name}`.toLowerCase().includes(q))) return;
    const r = attRecord(id, d); if (!sf || r.st === sf) recs.push(r);
  }));
  const pages = Math.max(1, Math.ceil(recs.length / PER_PAGE)); aPage = Math.min(aPage, pages);
  const from = (aPage - 1) * PER_PAGE, part = recs.slice(from, from + PER_PAGE);
  $('#a-head').innerHTML = A_COLS.map(([h, t]) => `<th class="py-2 font-normal pr-3"${t ? ` title="${t}"` : ''}>${h}</th>`).join('');
  $('#a-rows').innerHTML = part.length ? part.map(r => {
    const w = r.s.in != null, b = ATT_BADGE[r.st], live = r.running || r.onBreak;
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${r.id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${r.e.photo ? `<img class="avatar" src="${r.e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(r.e.name)}</span>`}<div class="leading-tight"><div>${esc(r.e.name)}</div><div class="muted text-xs">${esc(r.e.pos)}</div></div></div></td>
    <td class="pr-3 whitespace-nowrap">${w ? schedShort(r.s) : '—'}${schedChanged(r.id, r.d) ? '<div class="text-xs" style="color:var(--warn)" title="This day’s schedule was edited. Status and hours follow the updated schedule.">Schedule updated</div>' : ''}</td>
    ${[0, 1, 2, 3].map(i => `<td class="pr-3 whitespace-nowrap">${r.t[i] != null ? fmtMin(r.t[i]) : '—'}</td>`).join('')}
    <td class="pr-3 whitespace-nowrap ${live ? 'muted' : ''}" ${live ? `title="${r.onBreak ? 'On break' : 'Still clocked in'}"` : ''}>${r.t.length ? fmtHM(r.hrs) : '—'}</td>
    <td><span class="badge ${b[0]}">${b[1]}</span>${r.st === 'late' && r.note ? `<div class="text-xs mt-1" style="max-width:12rem">“${esc(r.note)}”</div>` : ''}</td></tr>`;
  }).join('') : `<tr class="border-t hair"><td colspan="9" class="py-8 text-center muted">No attendance records match your filters.</td></tr>`;
  $('#a-count').textContent = recs.length ? `Showing ${from + 1} to ${from + part.length} of ${recs.length} records` : 'Showing 0 records';
  const nums = []; for (let p = Math.max(1, aPage - 2); p <= Math.min(pages, Math.max(aPage + 2, 5)); p++) nums.push(p);
  $('#a-pager').innerHTML = `<button class="ghost !px-3" data-p="${aPage - 1}" ${aPage === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`
    + nums.map(p => `<button class="${p === aPage ? 'btn' : 'ghost'} !px-3" data-p="${p}">${p}</button>`).join('')
    + `<button class="ghost !px-3" data-p="${aPage + 1}" ${aPage === pages ? 'disabled' : ''} aria-label="Next page">›</button>`;
}
$('#a-modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { aMode = b.dataset.mode; aPage = 1; renderAttendance(); } });
$('#a-date').addEventListener('change', e => { aMode = e.target.value ? 'date' : 'today'; aPage = 1; renderAttendance(); });
['#a-q', '#a-pos', '#a-st'].forEach(s => $(s).addEventListener('input', () => { aPage = 1; renderAttendance(); }));
$('#a-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { aPage = +b.dataset.p; renderAttendance(); } });

$$('[data-soon]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); toast('Coming soon in this prototype.'); }));

/* ---------- Deductions ----------
   Automatic: Tardiness is DERIVED from attendRecord() (Attendance + Schedule), never stored,
   so it always matches the Attendance page. Manual: Cash Advance, Uniform Fee, Lost ID, Other are stored.
   Absences are NOT deducted: payroll pays only hours worked (avoids double-deducting). */
const DEF_RATE = 80, MAX_DAYS = 92; // fallback ₱/hr for staff without a rate; max range
const DED_TYPES = { tardiness: 'Tardiness', advance: 'Cash Advance', uniform: 'Uniform Fee', lostid: 'Lost ID', other: 'Other' };
const DED_MANUAL = ['tardiness', 'advance', 'uniform', 'lostid']; // fixed types shown in the filter and in Add deduction (Tardiness is also generated automatically); "Other" is added last and lets the admin type a new one
const DED_BADGE = { tardiness: 'b-err', advance: 'b-night', uniform: 'b-muted', lostid: 'b-err', other: 'b-muted' };
const DED_CUSTOM = store.get('dedTypes', []).filter(c => c && c.k && c.label); // types typed via "Other": [{ k, label }]. Empty at first, saved in localStorage
DED_CUSTOM.forEach(c => { DED_TYPES[c.k] = c.label; DED_BADGE[c.k] = 'b-muted'; });
const dedName = t => DED_TYPES[t] || 'Other'; // safe label lookup (call esc() when putting it in HTML)
const rateOf = id => EMP[id]?.rate > 0 ? EMP[id].rate : DEF_RATE;
const dedAmt = (id, mins) => Math.round(rateOf(id) / 60 * mins * 100) / 100; // hourly rate ÷ 60 × minutes
const num = n => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const seedDeds = () => [['STF-002', 'advance', 450, 'Wages advance', 1], ['STF-005', 'uniform', 100, 'Uniform fee', 2], ['STF-010', 'lostid', 150, 'Lost ID', 3], ['STF-004', 'advance', 300, 'Wages advance', 4], ['STF-007', 'other', 200, 'Approved deduction', 6]]
  .map(([id, type, amount, remarks, ago], i) => ({ k: 'm-' + (i + 1), id, type, amount, remarks, date: dkey(addDays(new Date(), -ago)) }));
const DED = store.get('deds', null) || seedDeds();
const saveDed = () => store.set('deds', DED);

function autoDeds(from, to) {
  const out = [], t0 = new Date(); t0.setHours(0, 0, 0, 0); if (to > t0) to = t0; // never look past today

  for (let d = new Date(to); d >= from; d = addDays(d, -1)) Object.entries(EMP).forEach(([id, e]) => {
    if (!e.active || e.draft || d < new Date(e.hired + 'T00:00')) return;
    const r = attRecord(id, d), date = dkey(d);
    if (r.st === 'late') { const m = r.tin - r.s.in; out.push({ k: `a-${id}-${date}-t`, auto: true, date, id, type: 'tardiness', amount: dedAmt(id, m), remarks: `Late by ${m} minute${m === 1 ? '' : 's'}` }); }
  });
  return out;
}
function dedRange() {
  const t = new Date(); t.setHours(0, 0, 0, 0); const p = $('#d-per').value, y = t.getFullYear(), m = t.getMonth();
  if (p === 'today') return [t, t];
  if (p === 'week') return [mondayOf(t), t];
  if (p === 'last') return [new Date(y, m - 1, 1), new Date(y, m, 0)];
  if (p === 'custom') {
    const a = $('#d-from').value, b = $('#d-to').value;
    let to = b ? new Date(b + 'T00:00') : t; if (to > t) to = t;
    let from = a ? new Date(a + 'T00:00') : new Date(y, m, 1); if (from > to) from = to;
    return [from < addDays(to, -MAX_DAYS) ? addDays(to, -MAX_DAYS) : from, to];
  }
  return [new Date(y, m, 1), t];
}
let dPage = 1;
const dpager = (page, pages) => {
  const n = []; for (let p = Math.max(1, page - 2); p <= Math.min(pages, Math.max(page + 2, 5)); p++) n.push(p);
  return `<button class="ghost !px-3" data-p="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>` + n.map(p => `<button class="${p === page ? 'btn' : 'ghost'} !px-3" data-p="${p}">${p}</button>`).join('') + `<button class="ghost !px-3" data-p="${page + 1}" ${page === pages ? 'disabled' : ''} aria-label="Next page">›</button>`;
};

/* Where a deduction lands in payroll (weekly periods, Mon–Sun) */
const dedPeriod = date => mondayOf(new Date(date + 'T00:00'));
const DED_STATE = {
  next:   ['b-muted', 'Next payroll'], // week not finished yet
  open:   ['b-warn',  'For payroll'],  // current period, payroll not generated yet
  in:     ['b-ok',    'In payroll'],   // Draft → Approved: figures still live
  locked: ['b-night', 'Processed']     // Processed/Released or already in History
};
function dedState(id, date) {
  const s = dedPeriod(date), cs = curStart();
  if (s > cs) return 'next';
  if (s < cs) return 'locked';
  const st = pStatus(s, id);
  return st === 'none' ? 'open' : (st === 'processed' || st === 'released') ? 'locked' : 'in';
}
function reopenIfApproved(id, date) { // figures changed after sign-off, so the approver must look again
  const k = pKey(dedPeriod(date), id);
  if (PAY[k] !== 'approved') return false;
  PAY[k] = 'review'; savePay(); return true;
}
function renderDeductions() {
  const custom = $('#d-per').value === 'custom', today = dkey(new Date());
  $('#d-from').classList.toggle('hidden', !custom); $('#d-to').classList.toggle('hidden', !custom); $('#d-from').max = $('#d-to').max = today;
  const [from, to] = dedRange(), fk = dkey(from), tk = dkey(to);
  if (custom) { if (!$('#d-from').value) $('#d-from').value = fk; if (!$('#d-to').value) $('#d-to').value = tk; }
  const curE = $('#d-emp').value, emps = Object.entries(EMP).filter(([, e]) => !e.draft);
  $('#d-emp').innerHTML = '<option value="">All Staff</option>' + emps.map(([id, e]) => `<option value="${id}">${esc(e.name)}</option>`).join('');
  $('#d-emp').value = EMP[curE] ? curE : '';
  const ef = $('#d-emp').value, tf = $('#d-type').value, q = $('#d-q').value.trim().toLowerCase();
  const all = [...autoDeds(from, to), ...DED.filter(x => x.date >= fk && x.date <= tk).map(x => ({ ...x, auto: false }))]
    .filter(x => EMP[x.id] && (!ef || x.id === ef) && (!tf || x.type === tf) && (!q || `${x.id} ${EMP[x.id].name}`.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const sum = l => l.reduce((s, x) => s + x.amount, 0), au = all.filter(x => x.auto), ma = all.filter(x => !x.auto);
  $('#d-stats').innerHTML = [['Total deductions', sum(all), all.length], ['From attendance', sum(au), au.length], ['Added manually', sum(ma), ma.length]]
    .map(([l, v, n]) => `<div class="card p-4"><div class="text-2xl font-semibold">${peso(v)}</div><div class="muted text-sm mt-1">${l} · ${n} record${n === 1 ? '' : 's'}</div></div>`).join('');
  const fm = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  $('#d-label').textContent = fk === tk ? fm(from) : `${fm(from)} – ${fm(to)}`;
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE)); dPage = Math.min(dPage, pages);
  const at = (dPage - 1) * PER_PAGE, part = all.slice(at, at + PER_PAGE);
  $('#d-rows').innerHTML = part.length ? part.map(x => {
    const e = EMP[x.id], stt = dedState(x.id, x.date), bd = DED_STATE[stt];
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${fmtDate(x.date)}</td><td class="pr-3 whitespace-nowrap">${x.id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
    <td class="pr-3 whitespace-nowrap">${esc(e.pos)}</td><td class="pr-3"><span class="badge ${DED_BADGE[x.type] || 'b-muted'}">${esc(dedName(x.type))}</span></td>
    <td class="pr-3 whitespace-nowrap">${num(x.amount)}</td><td class="pr-3">${esc(x.remarks || '—')}</td>
    <td class="pr-3"><span class="badge ${bd[0]}" title="Pay period: ${fmR(dedPeriod(x.date))}">${bd[1]}</span></td>
    <td class="whitespace-nowrap">${x.auto ? '<span class="muted text-xs" title="Generated from Attendance and Schedules">Automatic</span>'
      : stt === 'locked' ? '<span class="muted text-xs" title="This pay period is already processed">Locked</span>'
      : `<button class="ghost !py-1 !px-2 text-xs" data-dedit="${x.k}">Edit</button> <button class="ghost !py-1 !px-2 text-xs" style="color:var(--err)" data-ddel="${x.k}">Delete</button>`}</td></tr>`;
  }).join('')
    : '<tr class="border-t hair"><td colspan="9" class="py-8 text-center muted">No deductions match your filters.</td></tr>';
  $('#d-count').textContent = all.length ? `Showing ${at + 1} to ${at + part.length} of ${all.length} records` : 'Showing 0 records';
  $('#d-pager').innerHTML = dpager(dPage, pages);
  $('#d-note').textContent = `Tardiness (late beyond ${GRACE} min) is generated from Attendance and Schedules: hourly rate ÷ 60 × minutes late (₱${DEF_RATE}/hr if no rate is set). Absent days are unpaid. On days worked, payroll pays the scheduled hours. There is no overtime or undertime.`;
}
function refreshDedTypes(pick) { // keeps the filter and the Add deduction drop-down in step with the saved types
  const opt = (k, v) => `<option value="${esc(k)}">${esc(v)}</option>`, cf = $('#d-type').value;
  const keys = [...DED_MANUAL, ...DED_CUSTOM.map(c => c.k), 'other']; // same list for the filter and for Add deduction; "Other" always last
  $('#d-type').innerHTML = '<option value="">All Deduction Types</option>' + keys.map(k => opt(k, DED_TYPES[k])).join('');
  $('#d-type').value = keys.includes(cf) ? cf : '';
  $('#dm-type').innerHTML = keys.map(k => opt(k, DED_TYPES[k])).join('');
  if (pick) $('#dm-type').value = pick;
}
function resetDedTypes() { DED_CUSTOM.forEach(c => { delete DED_TYPES[c.k]; delete DED_BADGE[c.k]; }); DED_CUSTOM.length = 0; store.set('dedTypes', DED_CUSTOM); refreshDedTypes(); }
refreshDedTypes();
['#d-per', '#d-from', '#d-to', '#d-emp', '#d-type', '#d-q'].forEach(s => $(s).addEventListener('input', () => { dPage = 1; renderDeductions(); }));
$('#d-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { dPage = +b.dataset.p; renderDeductions(); } });

const dModal = $('#ded-modal');
let dEdit = null;
function openDed(k) {
  dEdit = k || null; const r = k ? DED.find(x => x.k === k) : null;
  $('#dm-emp').innerHTML = '<option value="">Select staff</option>' + Object.entries(EMP).filter(([id, e]) => (e.active && !e.draft) || id === r?.id).map(([id, e]) => `<option value="${id}">${id} · ${esc(e.name)}</option>`).join('');
  $('#dm-title').textContent = r ? 'Edit deduction' : 'Add deduction';
  $('#dm-emp').value = r?.id || ''; $('#dm-type').value = r?.type || 'advance'; $('#dm-date').value = r?.date || dkey(new Date()); $('#dm-date').max = dkey(new Date());
  $('#dm-amt').value = r?.amount ?? ''; $('#dm-rem').value = r?.remarks || ''; $('#dm-other').value = ''; paintOther();
  dModal.classList.remove('hidden'); dModal.classList.add('flex'); $('#dm-emp').focus();
}
const closeDed = () => { dModal.classList.add('hidden'); dModal.classList.remove('flex'); };
const paintOther = () => $('#dm-other-w').classList.toggle('hidden', $('#dm-type').value !== 'other'); // typing box only shows for "Other"
function commitOther() { // the typed name becomes a saved deduction type. Returns its key, null (keep a legacy "Other" record as is) or false (invalid)
  const name = $('#dm-other').value.trim().replace(/\s+/g, ' '), low = name.toLowerCase();
  if (!name) { if (dEdit && DED.find(x => x.k === dEdit)?.type === 'other') return null; toast('Type the deduction name.', 'err'); $('#dm-other').focus(); return false; }
  if (low === 'other') { toast('Type a specific name instead of “Other”.', 'err'); $('#dm-other').focus(); return false; }
  const hit = Object.entries(DED_TYPES).find(([, v]) => v.toLowerCase() === low); // already in the list: reuse it, no duplicates
  if (hit) { if (!DED_MANUAL.includes(hit[0]) && !DED_CUSTOM.some(c => c.k === hit[0])) { toast('Tardiness is generated automatically.', 'err'); return false; } return hit[0]; }
  const k = 'c' + Date.now().toString(36); DED_CUSTOM.push({ k, label: name }); DED_TYPES[k] = name; DED_BADGE[k] = 'b-muted';
  store.set('dedTypes', DED_CUSTOM); refreshDedTypes(k); toast('Deduction type added.'); return k;
}
$('#dm-type').addEventListener('change', () => { paintOther(); if (!$('#dm-other-w').classList.contains('hidden')) $('#dm-other').focus(); });
$('#dm-other').addEventListener('keydown', e => { // Enter saves the typed name to the drop-down straight away instead of submitting the form
  if (e.key !== 'Enter') return; e.preventDefault();
  const k = commitOther(); if (k) { $('#dm-type').value = k; $('#dm-other').value = ''; paintOther(); }
});
$('#add-ded').addEventListener('click', () => openDed());
$('#dm-x').addEventListener('click', closeDed); $('#dm-cancel').addEventListener('click', closeDed);
addEventListener('keydown', e => { if (e.key === 'Escape') closeDed(); });
$('#dm-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = $('#dm-emp').value, amount = Math.round(parseFloat($('#dm-amt').value) * 100) / 100, date = $('#dm-date').value;
  if (!id || !date || !(amount > 0)) { toast('Select a staff, date and an amount above zero.', 'err'); return; }
  if (date > dkey(new Date())) { toast('The date can’t be in the future.', 'err'); return; }
  const old = dEdit ? DED.find(x => x.k === dEdit) : null;
  if (old && dedState(old.id, old.date) === 'locked') { toast('This deduction belongs to a processed payroll and can’t be edited.', 'err'); return; }
  if (dedState(id, date) === 'locked') { toast(`Payroll for ${fmR(dedPeriod(date))} is already processed. Use a date in the current week so it’s included in the current payroll.`, 'err'); return; }
  let type = $('#dm-type').value;
  if (type === 'other') { const k = commitOther(); if (k === false) return; type = k || 'other'; }
  const rec = { k: dEdit || 'm-' + Date.now() + Math.random().toString(36).slice(2, 5), id, type, amount, date, remarks: $('#dm-rem').value.trim() };
  const i = DED.findIndex(x => x.k === dEdit); if (i >= 0) DED[i] = rec; else DED.push(rec);
  const back = [old && reopenIfApproved(old.id, old.date), reopenIfApproved(id, date)].some(Boolean); // array, so both run
  saveDed(); closeDed(); renderDeductions();
  const stt = dedState(id, date), nm = EMP[id].name;
  toast((stt === 'next' ? `Saved. It will be deducted in the payroll for ${fmR(dedPeriod(date))}.`
    : stt === 'open' ? `Saved. It will be included when payroll is generated for ${nm}.`
    : `Saved. ${nm}’s payroll now shows the new deduction.`) + (back ? ' The approved payroll was sent back for review.' : ''));
});
$('#d-rows').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.dedit) openDed(b.dataset.dedit);
  if (b.dataset.ddel) {
    const r = DED.find(x => x.k === b.dataset.ddel); if (!r) return;
    if (dedState(r.id, r.date) === 'locked') { toast('This pay period is already processed, so the deduction can’t be deleted.', 'err'); return; }
    const nm = EMP[r.id] ? EMP[r.id].name : r.id, dt = dedName(r.type);
    const ok = await confirmCard({ title: 'Delete deduction?', msg: `Delete the ${dt} deduction (${peso(r.amount)}) for ${nm}? This can’t be undone.`, ok: 'Delete', tone: 'danger' });
    if (!ok) return;
    DED.splice(DED.indexOf(r), 1);
    const back = reopenIfApproved(r.id, r.date);
    saveDed(); renderDeductions();
    toast(back ? 'Deduction deleted. The approved payroll was sent back for review.' : 'Deduction deleted.');
  }
});

/* ---------- Payroll ----------
   Weekly periods (Mon–Sun). The OPEN payroll is the current week, calculated live up to today so it is ready on the payroll date (the last day of the period).
   It stays on "Current payroll" until the week ends, then rolls into History. Processed and Released records are frozen (SNAP).
   Flow: Draft → For review → Approved → Processed → Released. Processing locks the figures; releasing the payslip is a separate, manual step. */
const PAY = store.get('pay', {}), SNAP = store.get('paysnap', {});
const savePay = () => { store.set('pay', PAY); store.set('paysnap', SNAP); };
const PAY_ST = { none: ['b-muted', 'Not generated'], draft: ['b-muted', 'Draft'], review: ['b-warn', 'For review'], approved: ['b-night', 'Approved'], processed: ['b-warn', 'Processed'], released: ['b-ok', 'Released'] };
const PAY_NEXT = { draft: ['review', 'Send for review'], review: ['approved', 'Approve'], approved: ['processed', 'Process payroll'], processed: ['released', 'Release payslip'] };
const slipOk = st => st === 'approved' || st === 'processed' || st === 'released'; // payslip can be previewed from Approved; printed only once Released
let pTab = 'current', pPage = 1, hPage = 1, pSel = new Set(), pOpen = null, hSel = null;
const curStart = () => mondayOf(new Date()), weekEnd = s => addDays(s, 6);
const pKey = (s, id) => dkey(s) + '|' + id, pStatus = (s, id) => PAY[pKey(s, id)] || 'none';
const sd = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmR = s => `${sd(s)} – ${weekEnd(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
function payCalc(id, from, to, A) {
  const today = new Date(); today.setHours(0, 0, 0, 0); const e = EMP[id];
  const c = { days: 0, present: 0, late: 0, absent: 0, mins: 0, reg: 0, lates: [] };
  for (let d = new Date(from); d <= to && d <= today; d = addDays(d, 1)) {
    if (d < new Date(e.hired + 'T00:00')) continue;
    const r = attRecord(id, d); if (r.s.in == null || r.st === 'upcoming') continue;
    c.days++;
    if (r.st === 'absent') c.absent++;
    else {
      c.present++; c.mins += r.hrs; c.reg += r.s.out - r.s.in; // paid on scheduled hours; only lateness is deducted
      if (r.st === 'late') { c.late++; c.lates.push({ d: new Date(d), tin: r.tin, sin: r.s.in }); }
    }
  }
  const fk = dkey(from), tk = dkey(to);
  c.ds = [...A.filter(x => x.id === id), ...DED.filter(x => x.id === id && x.date >= fk && x.date <= tk)];
  c.rate = rateOf(id); const R = m => Math.round(c.rate / 60 * m * 100) / 100;
  c.basic = R(c.reg); c.gross = c.basic; // no overtime
  c.ded = c.ds.reduce((s, x) => s + x.amount, 0); c.net = Math.max(0, c.gross - c.ded);
  c.log = dayLog(id, from); // day-by-day record, frozen with the payroll snapshot
  return c;
}
function payGet(id, s, A) { // processed and released records come from the frozen snapshot, everything else is live
  const k = pKey(s, id);
  if (SNAP[k]) return { ...SNAP[k], lates: SNAP[k].lates.map(l => ({ ...l, d: new Date(l.d) })) };
  return payCalc(id, s, weekEnd(s), A || autoDeds(s, weekEnd(s)));
}
function payRows(s, hist) {
  const ids = Object.keys(EMP).filter(id => hist ? PAY[pKey(s, id)] : EMP[id].active && !EMP[id].draft);
  const A = ids.every(id => SNAP[pKey(s, id)]) ? [] : autoDeds(s, weekEnd(s));
  return ids.map(id => ({ id, e: EMP[id], c: payGet(id, s, A), st: pStatus(s, id) }));
}
function payAdv(s, id, A) {
  const k = pKey(s, id), n = PAY_NEXT[PAY[k]]; if (!n) return false;
  PAY[k] = n[0]; if (n[0] === 'processed') SNAP[k] = payCalc(id, s, weekEnd(s), A || autoDeds(s, weekEnd(s))); // Processing locks the figures. Releasing only changes the status, not the numbers
  return true;
}
function resetPay() { // history: the last three closed periods are already processed and released, like a real payroll record
  Object.keys(PAY).forEach(k => delete PAY[k]); Object.keys(SNAP).forEach(k => delete SNAP[k]);
  [-7, -14, -21].forEach(off => {
    const s = addDays(curStart(), off), A = autoDeds(s, weekEnd(s));
    Object.keys(EMP).filter(id => EMP[id].active && !EMP[id].draft).forEach(id => { PAY[pKey(s, id)] = 'released'; SNAP[pKey(s, id)] = payCalc(id, s, weekEnd(s), A); });
  });
  store.set('payv', 5); savePay();
}
if (store.get('payv', 0) !== 5) resetPay(); // v5: current period is the live week, history starts with last week

const dedCell = c => `<td class="pr-3"${c.ds.length ? ` title="${esc(c.ds.map(x => dedName(x.type) + ' ' + num(x.amount)).join(', '))}"` : ''}>${num(c.ded)}${c.ds.length ? `<div class="muted text-xs">${c.ds.length} item${c.ds.length === 1 ? '' : 's'}</div>` : ''}</td>`;
const payRowHtml = ({ id, e, c, st }, chk) => `<tr class="border-t hair">${chk ? `<td class="py-2.5 pr-3"><input type="checkbox" data-sel="${id}" ${pSel.has(id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></td>` : ''}<td class="${chk ? '' : 'py-2.5 '}pr-3 whitespace-nowrap">${id}</td>
  <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
  <td class="pr-3 whitespace-nowrap">${esc(e.pos)}</td><td class="pr-3">${num(c.rate)}</td><td class="pr-3 whitespace-nowrap">${fmtHM(c.mins)}</td><td class="pr-3">${num(c.gross)}</td>${dedCell(c)}<td class="pr-3 font-medium">${num(c.net)}</td>
  <td class="pr-3"><span class="badge ${PAY_ST[st][0]}">${PAY_ST[st][1]}</span></td>
  <td class="whitespace-nowrap"><button class="ghost !py-1 !px-2 text-xs" data-pv="${id}">View</button> <button class="ghost !py-1 !px-2 text-xs" data-ps="${id}" ${slipOk(st) ? '' : 'disabled title="Available once payroll is approved"'}>Payslip</button></td></tr>`;

function renderPayroll() {
  $$('#p-tabs button').forEach(b => b.className = b.dataset.tab === pTab ? 'btn text-sm' : 'ghost text-sm');
  const cur = pTab === 'current'; $('#p-cur').classList.toggle('hidden', !cur); $('#p-his').classList.toggle('hidden', cur);
  $('#p-gen').classList.toggle('hidden', !cur); $('#p-adv').classList.toggle('hidden', !cur);
  cur ? renderPayCur() : renderPayHis();
}
function renderPayCur() {
  const s = curStart();
  $('#p-label').textContent = `Current payroll period: ${fmR(s)}`;
  $('#p-info').textContent = `Figures are live and updated up to today (${sd(new Date())}). Payroll date: ${weekEnd(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}. After that, this period moves to History.`;
  const all = payRows(s), cp = $('#p-pos').value, poss = [...new Set(all.map(r => r.e.pos))].sort();
  $('#p-pos').innerHTML = '<option value="">All Positions</option>' + poss.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#p-pos').value = poss.includes(cp) ? cp : '';
  const q = $('#p-q').value.trim().toLowerCase(), pf = $('#p-pos').value, sf = $('#p-st').value;
  const rows = all.filter(r => (!q || `${r.id} ${r.e.name}`.toLowerCase().includes(q)) && (!pf || r.e.pos === pf) && (!sf || r.st === sf));
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); pPage = Math.min(pPage, pages);
  const at = (pPage - 1) * PER_PAGE, part = rows.slice(at, at + PER_PAGE), sum = k => rows.reduce((t, r) => t + r.c[k], 0);
  $('#p-all').checked = part.length > 0 && part.every(r => pSel.has(r.id));
  $('#p-rows').innerHTML = part.length ? part.map(r => payRowHtml(r, true)).join('') : '<tr class="border-t hair"><td colspan="11" class="py-8 text-center muted">No payroll records match your filters.</td></tr>';
  $('#p-count').textContent = rows.length ? `Showing ${at + 1} to ${at + part.length} of ${rows.length} records` : 'Showing 0 records';
  $('#p-pager').innerHTML = dpager(pPage, pages);
  $('#p-stats').innerHTML = [['Total staff', rows.length], ['Total gross pay', peso(sum('gross'))], ['Total deductions', peso(sum('ded'))], ['Total net pay', peso(sum('net'))]]
    .map(([l, v]) => `<div class="card p-4"><div class="text-2xl font-semibold">${v}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
}
function renderPayHis() {
  const cs = dkey(curStart()), ks = [...new Set(Object.keys(PAY).map(k => k.slice(0, 10)))].filter(k => k < cs).sort().reverse();
  if (hSel && !ks.includes(hSel)) hSel = null;
  $('#h-rows').innerHTML = ks.length ? ks.map(k => {
    const s = new Date(k + 'T00:00'), rs = payRows(s, true), pend = rs.filter(r => r.st !== 'released').length, t = f => num(rs.reduce((x, r) => x + r.c[f], 0));
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${fmR(s)}</td><td class="pr-3">${rs.length}</td><td class="pr-3">${t('gross')}</td><td class="pr-3">${t('ded')}</td><td class="pr-3 font-medium">${t('net')}</td>
    <td class="pr-3"><span class="badge ${pend ? 'b-warn' : 'b-ok'}">${pend ? pend + ' pending' : 'Completed'}</span></td><td><button class="ghost !py-1 !px-2 text-xs" data-hp="${k}">${hSel === k ? 'Viewing' : 'View records'}</button></td></tr>`;
  }).join('') : '<tr class="border-t hair"><td colspan="7" class="py-8 text-center muted">No previous pay periods yet.</td></tr>';
  $('#h-detail').classList.toggle('hidden', !hSel); if (!hSel) return;
  const s = new Date(hSel + 'T00:00'), rows = payRows(s, true), pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); hPage = Math.min(hPage, pages);
  const at = (hPage - 1) * PER_PAGE, part = rows.slice(at, at + PER_PAGE);
  $('#hd-title').textContent = `Payroll records: ${fmR(s)}`;
  $('#hd-rows').innerHTML = part.map(r => payRowHtml(r, false)).join('');
  $('#hd-count').textContent = `Showing ${at + 1} to ${at + part.length} of ${rows.length} records`;
  $('#hd-pager').innerHTML = dpager(hPage, pages);
}
$$('#p-tabs button').forEach(b => b.addEventListener('click', () => { pTab = b.dataset.tab; renderPayroll(); }));
['#p-pos', '#p-st', '#p-q'].forEach(s => $(s).addEventListener('input', () => { pPage = 1; renderPayroll(); }));
$('#p-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { pPage = +b.dataset.p; renderPayroll(); } });
$('#hd-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { hPage = +b.dataset.p; renderPayroll(); } });
$('#p-all').addEventListener('change', e => { $$('#p-rows [data-sel]').forEach(c => { c.checked = e.target.checked; e.target.checked ? pSel.add(c.dataset.sel) : pSel.delete(c.dataset.sel); }); });
$('#p-gen').addEventListener('click', () => {
  const s = curStart(), rs = payRows(s).filter(r => r.st === 'none'); rs.forEach(r => PAY[pKey(s, r.id)] = 'draft'); savePay(); renderPayroll();
  toast(rs.length ? `Payroll generated as draft for ${rs.length} staff${rs.length === 1 ? '' : 's'}.` : 'Payroll is already generated for this period.');
});
$('#p-adv').addEventListener('click', async () => {
  const s = curStart(), A = autoDeds(s, weekEnd(s));
  if (!pSel.size) { toast('Select staff first.', 'err'); return; }
  const rows = [...pSel].filter(id => PAY_NEXT[pStatus(s, id)]);
  if (!rows.length) { toast('Selected records have no next step.', 'err'); return; }
  // Group by next step so one card covers the bulk approve / process / release.
  const by = {};
  rows.forEach(id => { const n = PAY_NEXT[pStatus(s, id)][0]; (by[n] = by[n] || []).push(id); });
  const [[next, ids]] = Object.entries(by).sort((a, b) => b[1].length - a[1].length);
  const label = { review: 'Approve', approved: 'Process payroll for', processed: 'Release payslips for' }[next] || PAY_NEXT[PAY[pKey(s, ids[0])]][1];
  const extra = Object.keys(by).length > 1 ? ` (+${rows.length - ids.length} more at other steps)` : '';
  const names = ids.slice(0, 3).map(id => EMP[id].name).join(', ') + (ids.length > 3 ? ` +${ids.length - 3} more` : '');
  const ok = await confirmCard({
    title: next === 'review' ? 'Approve payroll?' : next === 'approved' ? 'Process payroll?' : 'Release payslips?',
    msg: `${label} ${ids.length} staff (${names})${extra} for ${fmR(s)}?${next === 'approved' ? ' Processing locks the figures.' : next === 'processed' ? ' Staff will see the final amounts.' : ''}`,
    ok: next === 'review' ? `Approve ${ids.length}` : next === 'approved' ? `Process ${ids.length}` : `Release ${ids.length}`,
    tone: next === 'review' || next === 'processed' ? 'ok' : 'warn',
  });
  if (!ok) return;
  let n = 0; ids.forEach(id => { if (payAdv(s, id, A)) n++; });
  pSel.clear(); savePay(); renderPayroll();
  toast(`${n} payroll record${n === 1 ? '' : 's'} moved to the next step.`);
});
$('#h-rows').addEventListener('click', e => { const b = e.target.closest('[data-hp]'); if (b) { hSel = b.dataset.hp; hPage = 1; renderPayroll(); } });
$('#hd-back').addEventListener('click', () => { hSel = null; renderPayroll(); });
const pModal = $('#pay-modal');
function openPay(id, s, slip, ro) {
  pOpen = { id, s, slip }; const e = EMP[id], c = payGet(id, s), st = pStatus(s, id);
  const line = (k, v, b) => `<div class="flex justify-between ${b ? 'font-semibold' : ''}"><dt class="${b ? '' : 'muted'}">${k}</dt><dd>${v}</dd></div>`;
  $('#pm-title').textContent = slip ? 'Payslip' : 'Payroll details';
  $('#pm-body').innerHTML = `<div><div class="font-medium">${esc(e.name)}</div><div class="muted">${id} · ${esc(e.pos)}</div><div class="muted text-xs mt-1">Pay period: ${fmR(s)} · <span class="badge ${PAY_ST[st][0]}">${PAY_ST[st][1]}</span></div></div>
  <div><h3 class="font-medium mb-2">Attendance summary</h3><dl class="space-y-1 border-t hair pt-2">${line('Scheduled days', c.days)}${line('Days present', c.present)}${line('Late', c.late)}${line('Absent', c.absent)}${line('Total hours', fmtHM(c.mins))}</dl></div>
  <div><h3 class="font-medium mb-2">Payroll</h3><dl class="space-y-1 border-t hair pt-2">${line('Rate', peso(c.rate) + '/hr')}${line('Gross pay', peso(c.gross))}${c.ds.map(x => line(`${esc(dedName(x.type))} <span class="text-xs">(${fmtDate(x.date)})</span>`, '− ' + num(x.amount))).join('')}${line('Total deductions', peso(c.ded))}<div class="border-t hair pt-2">${line('NET PAY', peso(c.net), 1)}</div></dl></div>
  ${c.lates.length ? `<div><h3 class="font-medium mb-2">Late attendance</h3><ul class="space-y-2">${c.lates.map(l => `<li class="card p-3"><div>${l.d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${fmtMin(l.tin)}</div><div class="muted text-xs">Scheduled ${fmtMin(l.sin)} · Late by ${l.tin - l.sin} min</div></li>`).join('')}</ul></div>` : ''}`;
  const nx = PAY_NEXT[st], a = $('#pm-act'); a.classList.toggle('hidden', !(nx && !slip && !ro)); // always a real boolean: toggle(x, undefined) flips instead of forcing // reports are read-only
  if (nx) a.textContent = nx[1];
  pModal.classList.remove('hidden'); pModal.classList.add('flex');
}
const closePay = () => { pModal.classList.add('hidden'); pModal.classList.remove('flex'); };
$('#pm-x').addEventListener('click', closePay); $('#pm-close').addEventListener('click', closePay);
addEventListener('keydown', e => { if (e.key === 'Escape' && !cfResolve) closePay(); });
$('#pm-act').addEventListener('click', async () => {
  const { id, s } = pOpen, st = pStatus(s, id), c = payGet(id, s);
  const nx = PAY_NEXT[st]; if (!nx) return;
  const cfg = {
    review: { title: 'Approve payroll?', msg: `${EMP[id].name}: approve ${peso(c.net)} net pay for ${fmR(s)}?`, ok: 'Approve', tone: 'ok' },
    approved: { title: 'Process payroll?', msg: `${EMP[id].name}: process payroll for ${fmR(s)}? This locks the figures (${peso(c.net)} net pay).`, ok: 'Process payroll', tone: 'warn' },
    processed: { title: 'Release payslip?', msg: `${EMP[id].name}: release the payslip (${peso(c.net)}) for ${fmR(s)}? Staff will see the final amounts.`, ok: 'Release payslip', tone: 'ok' },
  }[nx[0]] || { title: nx[1] + '?', msg: `${EMP[id].name}: ${nx[1].toLowerCase()} for ${fmR(s)}?`, ok: nx[1], tone: 'warn' };
  if (!await confirmCard(cfg)) return;
  payAdv(s, id); savePay();
  const ns = pStatus(s, id);
  toast(ns === 'released' ? `${EMP[id].name}: Payslip released.` : `${EMP[id].name}: ${PAY_ST[ns][1]}.`);
  closePay(); renderPayroll();
});
const payClick = (e, s) => {
  const b = e.target.closest('button'), c = e.target.closest('[data-sel]');
  if (c) { c.checked ? pSel.add(c.dataset.sel) : pSel.delete(c.dataset.sel); return; }
  if (b && b.dataset.pv) openPay(b.dataset.pv, s); else if (b && b.dataset.ps && !b.disabled) psGoto(b.dataset.ps, s);
};
$('#p-rows').addEventListener('click', e => payClick(e, curStart()));
$('#hd-rows').addEventListener('click', e => payClick(e, new Date(hSel + 'T00:00')));

/* ---------- Reports: read-only analysis of generated payroll (current period + history) ---------- */
const hrs2 = m => (m / 60).toFixed(2);
let rPage = 1, rView = { rows: [], s: null };
function renderReports() {
  const ks = [...new Set([...Object.keys(PAY).map(k => k.slice(0, 10)), dkey(curStart())])].sort().reverse(), cur = $('#r-per').value;
  $('#r-per').innerHTML = ks.map(k => `<option value="${k}">${fmR(new Date(k + 'T00:00'))}${k === dkey(curStart()) ? ' (current)' : ''}</option>`).join('');
  $('#r-per').value = ks.includes(cur) ? cur : (ks.find(k => payRows(new Date(k + 'T00:00'), true).length) || ks[0]); // default: latest period with records
  const s = new Date($('#r-per').value + 'T00:00'), all = payRows(s, true), prev = payRows(addDays(s, -7), true);
  $('#r-label').textContent = `Pay period: ${fmR(s)}`;
  const ce = $('#r-emp').value, cp = $('#r-pos').value, poss = [...new Set(all.map(r => r.e.pos))].sort();
  $('#r-emp').innerHTML = '<option value="">All Staff</option>' + all.map(r => `<option value="${r.id}">${esc(r.e.name)}</option>`).join('');
  $('#r-emp').value = all.some(r => r.id === ce) ? ce : '';
  $('#r-pos').innerHTML = '<option value="">All Positions</option>' + poss.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#r-pos').value = poss.includes(cp) ? cp : '';
  const q = $('#r-q').value.trim().toLowerCase(), ef = $('#r-emp').value, pf = $('#r-pos').value, sf = $('#r-st').value;
  const f = r => (!q || `${r.id} ${r.e.name}`.toLowerCase().includes(q)) && (!ef || r.id === ef) && (!pf || r.e.pos === pf) && (!sf || r.st === sf);
  const rows = all.filter(f), pr = prev.filter(f); rView = { rows, s };
  const sum = (l, k) => l.reduce((t, r) => t + r.c[k], 0), pending = rows.filter(r => r.st === 'review').length;
  const dl = (cur, old, bad) => old > 0 ? `<span style="color:var(--${(cur >= old) !== !!bad ? 'ok' : 'err'})">${cur >= old ? '▲' : '▼'} ${Math.abs(Math.round((cur - old) / old * 100))}%</span> vs. previous period` : 'No previous period data';
  $('#r-stats').innerHTML = [['Total staff', rows.length, 'for selected period'], ['Total gross pay', peso(sum(rows, 'gross')), dl(sum(rows, 'gross'), sum(pr, 'gross'))], ['Total deductions', peso(sum(rows, 'ded')), dl(sum(rows, 'ded'), sum(pr, 'ded'), 1)],
  ['Total net pay', peso(sum(rows, 'net')), dl(sum(rows, 'net'), sum(pr, 'net'))], ['Total payroll cost', peso(sum(rows, 'gross')), dl(sum(rows, 'gross'), sum(pr, 'gross'))]]
    .map(([l, v, n]) => `<div class="card p-4"><div class="muted text-sm">${l}</div><div class="text-2xl font-semibold mt-1">${v}</div><div class="muted text-xs mt-1">${n}</div></div>`).join('');
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); rPage = Math.min(rPage, pages);
  const at = (rPage - 1) * PER_PAGE, part = rows.slice(at, at + PER_PAGE);
  $('#r-rows').innerHTML = part.length ? part.map(({ id, e, c, st }) => `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
    <td class="pr-3 whitespace-nowrap">${esc(e.pos)}</td><td class="pr-3 whitespace-nowrap">${fmR(s)}</td><td class="pr-3 whitespace-nowrap">${fmtHM(c.mins)}</td><td class="pr-3">${num(c.gross)}</td><td class="pr-3">${num(c.ded)}</td><td class="pr-3 font-medium">${num(c.net)}</td>
    <td class="pr-3"><span class="badge ${PAY_ST[st][0]}">${PAY_ST[st][1]}</span></td>
    <td class="whitespace-nowrap no-print"><button class="ghost !py-1 !px-2 text-xs" data-rv="${id}">View details</button></td></tr>`).join('')
    : `<tr class="border-t hair"><td colspan="10" class="py-8 text-center muted">${all.length ? 'No payroll records match your filters.' : 'No payroll has been generated for this period yet. Go to Payroll and click Generate payroll.'}</td></tr>`;
  $('#r-count').textContent = rows.length ? `Showing ${at + 1} to ${at + part.length} of ${rows.length} records` : 'Showing 0 records';
  $('#r-pager').innerHTML = dpager(rPage, pages);
  $('#r-sum').innerHTML = [['Total staff', rows.length], ['Total gross pay', peso(sum(rows, 'gross'))], ['Total deductions', peso(sum(rows, 'ded'))], ['Total net pay', peso(sum(rows, 'net'))], ['Pending review', pending]]
    .map(([l, v]) => `<div><div class="muted text-xs">${l}</div><div class="font-semibold text-lg">${v}</div></div>`).join('');
}
['#r-per', '#r-emp', '#r-pos', '#r-st', '#r-q'].forEach(x => $(x).addEventListener('input', () => { rPage = 1; renderReports(); }));
$('#r-reset').addEventListener('click', () => { $('#r-per').value = '';['#r-emp', '#r-pos', '#r-st', '#r-q'].forEach(x => $(x).value = ''); rPage = 1; renderReports(); });
$('#r-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { rPage = +b.dataset.p; renderReports(); } });
$('#r-rows').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; if (b.dataset.rv) openPay(b.dataset.rv, rView.s, false, true); });
$('#r-exp').addEventListener('click', e => { e.stopPropagation(); $('#r-menu').classList.toggle('hidden'); });
addEventListener('click', () => $('#r-menu').classList.add('hidden'));
addEventListener('afterprint', () => document.body.classList.remove('print-report'));
$('#r-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-exp]'); if (!b) return;
  if (!rView.rows.length) { toast('There are no records to export.', 'err'); return; }
  if (b.dataset.exp === 'pdf') { document.body.classList.add('print-report'); window.print(); return; }
  const cell = v => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; // quote fields; neutralize spreadsheet formulas
  const head = ['Staff ID', 'Staff Name', 'Position', 'Pay Period', 'Total Hours Worked', 'Gross Pay', 'Deductions', 'Net Pay', 'Status'], s = rView.s, per = `${dkey(s)} to ${dkey(weekEnd(s))}`;
  const lines = rView.rows.map(({ id, e, c, st }) => [id, e.name, e.pos, per, hrs2(c.mins), c.gross.toFixed(2), c.ded.toFixed(2), c.net.toFixed(2), PAY_ST[st][1]]);
  const t = k => rView.rows.reduce((x, r) => x + r.c[k], 0).toFixed(2);
  lines.push(['TOTAL', '', '', per, '', t('gross'), t('ded'), t('net'), '']);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + [head, ...lines].map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = `payroll-report_${dkey(s)}_to_${dkey(weekEnd(s))}.csv`; a.click(); URL.revokeObjectURL(a.href); toast('Report exported.');
});

/* ---------- Payslips: list first; the payslip itself only opens after View ---------- */
const PS_ST = { none: ['b-muted', 'Not generated'], draft: ['b-muted', 'Not generated'], review: ['b-muted', 'Not generated'], approved: ['b-night', 'Approved'], processed: ['b-warn', 'Ready for release'], released: ['b-ok', 'Released'] };
let psPage = 1, psSel = null; // psSel = { id, k: period start key }
const longD = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
function dayLog(id, s) {
  const today = new Date(); today.setHours(0, 0, 0, 0); const out = [], e = EMP[id];
  for (let i = 0; i < 7; i++) {
    const d = addDays(s, i); if (d > today) break;
    const r = attRecord(id, d);
    out.push({ d: dkey(d), st: d < new Date(e.hired + 'T00:00') ? 'na' : r.st, tin: r.tin, tout: r.tout, hrs: r.tin != null ? r.hrs : 0 });
  }
  return out;
}
function psHtml(id, s, st) {
  const e = EMP[id], c = payGet(id, s), log = c.log || dayLog(id, s), g = {};
  c.ds.forEach(x => g[x.type] = (g[x.type] || 0) + x.amount);
  const att = log.map(l => {
    const d = new Date(l.d + 'T00:00'), lbl = { off: 'Day off', leave: 'On leave', absent: 'Absent' }[l.st] || '—';
    return `<tr><td>${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>${d.toLocaleDateString('en-US', { weekday: 'short' })}</td><td>${l.tin != null ? fmtMin(l.tin) : `<span class="mu">${lbl}</span>`}</td><td>${l.tout != null ? fmtMin(l.tout) : '—'}</td><td class="r">${l.tin != null ? fmtHM(l.hrs) : '—'}</td></tr>`;
  }).join('');
  const ded = Object.entries(g).map(([t, v]) => `<tr><td>${esc(dedName(t))}</td><td class="r">${num(v)}</td></tr>`).join('') || '<tr><td>No deductions</td><td class="r">0.00</td></tr>';
  return `<div class="ps">${st === 'released' ? '' : '<div class="ps-note">Preview only. This payslip has not been released yet. Release it from Payroll once payroll is processed.</div>'}
  <div class="ps-head"><div><h2>STAFF PAYSLIP</h2></div><div style="text-align:right"><div style="font-weight:700;font-size:1rem">${esc(bizName())}</div><div class="mu">Bulacan, Philippines</div></div></div>
  <dl class="ps-info"><dt>Staff Name</dt><dd>: ${esc(e.name)}</dd><dt>Staff ID</dt><dd>: ${id}</dd><dt>Position</dt><dd>: ${esc(e.pos)}</dd><dt>Pay Period</dt><dd>: ${longD(s)} – ${longD(weekEnd(s))}</dd><dt>Pay Date</dt><dd>: ${longD(weekEnd(s))}</dd></dl>
  <h3>1. Attendance summary</h3><table><thead><tr><th>Date</th><th>Day</th><th>Time in</th><th>Time out</th><th class="r">Total hours</th></tr></thead><tbody>${att}<tr class="ps-tot"><td colspan="4" class="r">Total Hours Worked</td><td class="r">${fmtHM(c.mins)}</td></tr></tbody></table>
  <div class="ps-cols"><div><h3>2. Earnings / gross pay</h3><table><thead><tr><th>Description</th><th class="r">Amount (₱)</th></tr></thead><tbody>
    <tr class="ps-tot"><td>GROSS PAY</td><td class="r">${peso(c.gross)}</td></tr></tbody></table></div>
  <div><h3>3. Deductions</h3><table><thead><tr><th>Description</th><th class="r">Amount (₱)</th></tr></thead><tbody>${ded}<tr class="ps-tot"><td>TOTAL DEDUCTIONS</td><td class="r">${peso(c.ded)}</td></tr></tbody></table></div></div>
  <div class="ps-net"><span>NET PAY</span><span>${peso(c.net)}</span></div>
  <div class="ps-sig"><span>Thank you for your hard work!</span><span>Authorized Signature</span></div></div>`;
}
function psGoto(id, s) { psSel = { id, k: dkey(s) }; go('payslips'); }
function renderPayslips() {
  const ks = [...new Set([...Object.keys(PAY).map(k => k.slice(0, 10)), dkey(curStart())])].sort().reverse(), want = psSel ? psSel.k : $('#ps-per').value;
  $('#ps-per').innerHTML = ks.map(k => `<option value="${k}">${fmR(new Date(k + 'T00:00'))}${k === dkey(curStart()) ? ' (current)' : ''}</option>`).join('');
  $('#ps-per').value = ks.includes(want) ? want : (ks.find(k => payRows(new Date(k + 'T00:00'), true).length) || ks[0]); // default: latest period with records
  const k = $('#ps-per').value, s = new Date(k + 'T00:00'), all = payRows(s, k !== dkey(curStart()));
  const q = $('#ps-q').value.trim().toLowerCase(), rows = all.filter(r => !q || `${r.id} ${r.e.name}`.toLowerCase().includes(q));
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); psPage = Math.min(psPage, pages);
  const at = (psPage - 1) * PER_PAGE, part = rows.slice(at, at + PER_PAGE);
  $('#ps-rows').innerHTML = part.length ? part.map(({ id, e, st }) => {
    const can = slipOk(st);
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
    <td class="pr-3 whitespace-nowrap">${fmR(s)}</td><td class="pr-3"><span class="badge ${PS_ST[st][0]}">${PS_ST[st][1]}</span></td>
    <td class="whitespace-nowrap"><button class="ghost !py-1 !px-2 text-xs" data-psv="${id}" ${can ? '' : 'disabled title="Available once payroll is approved"'}>${psSel && psSel.id === id && psSel.k === k ? 'Viewing' : 'View'}</button></td></tr>`;
  }).join('')
    : '<tr class="border-t hair"><td colspan="5" class="py-8 text-center muted">No payslips match your filters.</td></tr>';
  $('#ps-count').textContent = rows.length ? `Showing ${at + 1} to ${at + part.length} of ${rows.length} records` : 'Showing 0 records';
  $('#ps-pager').innerHTML = dpager(psPage, pages);
  const sel = psSel && psSel.k === k && all.find(r => r.id === psSel.id && slipOk(r.st));
  if (!sel) psSel = null;
  $('#ps-panel').classList.toggle('hidden', !sel); $('#ps-wrap').classList.toggle('open', !!sel);
  if (sel) { $('#ps-doc').innerHTML = psHtml(sel.id, s, sel.st); $('#ps-dl').disabled = sel.st !== 'released'; }
}
function downloadSlip(id, s) {
  const html = psHtml(id, s, 'released');
  const blob = new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title><style>${document.querySelector('style')?.textContent || ''}</style></head><body>${html}</body></html>`], { type: 'text/html' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `payslip-${id}-${dkey(s)}.html`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function downloadAllPayslips() {
  const k = $('#ps-per').value, s = new Date(k + 'T00:00'), rows = payRows(s, k !== dkey(curStart())).filter(r => r.st === 'released');
  if (!rows.length) { toast('No released payslips are available for this pay period.', 'err'); return; }
  rows.forEach((r, i) => setTimeout(() => downloadSlip(r.id, s), i * 120));
  toast(`Downloading ${rows.length} released payslip${rows.length === 1 ? '' : 's'}.`);
}
$('#ps-per').addEventListener('input', () => { psSel = null; psPage = 1; renderPayslips(); });
$('#ps-q').addEventListener('input', () => { psPage = 1; renderPayslips(); });
$('#ps-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { psPage = +b.dataset.p; renderPayslips(); } });
$('#ps-rows').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return; const k = $('#ps-per').value;
  if (b.dataset.psv) { psSel = { id: b.dataset.psv, k }; renderPayslips(); if (innerWidth < 1280) $('#ps-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});
$('#ps-close').addEventListener('click', () => { psSel = null; renderPayslips(); });
$('#ps-dl').addEventListener('click', () => { if (psSel) downloadSlip(psSel.id, new Date(psSel.k + 'T00:00')); });
$('#ps-all-dl').addEventListener('click', downloadAllPayslips);

/* ---------- Sidebar (hamburger) ---------- */
const side = $('#sidebar'), overlay = $('#overlay'), isDesk = () => matchMedia('(min-width:1024px)').matches;
let collapsed = false;
function applySide() {
  if (isDesk()) { overlay.classList.add('hidden'); side.style.transform = 'none'; side.style.marginLeft = collapsed ? '-15rem' : '0'; }
  else { side.style.marginLeft = '0'; side.style.transform = collapsed ? 'translateX(-100%)' : 'none'; overlay.classList.toggle('hidden', collapsed); }
}
$('#burger').addEventListener('click', () => { collapsed = !collapsed; applySide(); });
overlay.addEventListener('click', () => { collapsed = true; applySide(); });
addEventListener('resize', () => { collapsed = !isDesk(); applySide(); });

/* ---------- Router ---------- */
const SHELL = ['dashboard', 'employees', 'schedules', 'attendance', 'deductions', 'payroll', 'reports', 'payslips'];
function route() {
  let v = location.hash.slice(2) || (sess ? 'home' : 'login');
  if (!['home', 'login', 'register', 'scan', 'verify', 'dashboard', 'employees', 'schedules', 'attendance', 'deductions', 'payroll', 'reports', 'payslips', 'qr'].includes(v)) v = sess ? 'home' : 'login';
  if (v !== 'login' && v !== 'register' && !sess) v = 'login'; // everything sits behind login
  if ((v === 'login' || v === 'register') && sess) v = 'home';
  if (v === 'verify' && !pending) v = 'scan';
  if (!SHELL.includes(v)) unlocked = false; // leaving payroll locks it again
  if (SHELL.includes(v) && !unlocked) { pinTarget = v; v = 'pin'; }
  $$('.view').forEach(x => x.classList.remove('on'));
  const shell = SHELL.includes(v); // both pages share the sidebar layout
  $('#v-' + (shell ? 'dashboard' : v)).classList.add('on');
  stopCam();
  if (v === 'scan') startScan();
  if (v === 'verify') startVerify();
  if (v === 'qr') renderQR();
  if (v === 'pin') paintPin();
  if (v === 'home') $('#home-hi').textContent = `Signed in as ${sess.name}. Choose a module to continue.`;
  if (shell) {
    $('#page-dashboard').classList.toggle('hidden', v !== 'dashboard');
    $('#page-employees').classList.toggle('hidden', v !== 'employees');
    $('#page-schedules').classList.toggle('hidden', v !== 'schedules');
    $('#page-attendance').classList.toggle('hidden', v !== 'attendance');
    $('#page-deductions').classList.toggle('hidden', v !== 'deductions');
    $('#page-payroll').classList.toggle('hidden', v !== 'payroll');
    $('#page-reports').classList.toggle('hidden', v !== 'reports');
    $('#page-payslips').classList.toggle('hidden', v !== 'payslips');
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.page === v));
    if (v === 'dashboard') renderDash(); else if (v === 'employees') renderStaff(); else if (v === 'schedules') renderSchedule(); else if (v === 'deductions') renderDeductions(); else if (v === 'payroll') renderPayroll(); else if (v === 'reports') renderReports(); else if (v === 'payslips') renderPayslips(); else renderAttendance();
    collapsed = !isDesk(); applySide();
  }
}
addEventListener('hashchange', route);
collapsed = !isDesk(); applySide();
route();
