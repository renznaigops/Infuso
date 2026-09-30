/* InfusoPay prototype – hash-routed views: home, login, register, scan, verify, dashboard */
'use strict';

/* ---------- Demo data & state ---------- */
const ROSTER = [
  ['Ana Reyes', 'Barista'], ['Ben Cruz', 'Cashier'], ['Carla Santos', 'Kitchen staff'], ['Daniel Garcia', 'Barista'], ['Elena Mendoza', 'Cashier'],
  ['Francis Dela Cruz', 'Kitchen staff'], ['Grace Villanueva', 'Barista'], ['Hector Ramos', 'Server'], ['Isabel Navarro', 'Server'], ['Jonas Bautista', 'Barista'],
  ['Katrina Lopez', 'Cashier'], ['Luis Aquino', 'Dishwasher'], ['Maya Torres', 'Server'], ['Noel Pascual', 'Kitchen staff'], ['Olivia Castillo', 'Barista'],
];
const SHIFTS = [[480, '8:00 AM – 5:00 PM'], [600, '10:00 AM – 7:00 PM'], [900, '3:00 PM – 12:00 AM']]; // [start minute, label]
const EMP = {}; // id -> { name, pos, contact, hired, shift, active, start, sch }
const pad = n => String(n).padStart(3, '0');
const withShift = e => { e.start = SHIFTS[e.shift][0]; e.sch = SHIFTS[e.shift][1]; return e; };
function defaultEmps() {
  const o = {};
  ROSTER.forEach(([name, pos], i) => {
    const d = new Date(2024, 0, 10 + i * 38), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    o['EMP-' + pad(i + 1)] = withShift({ name, pos, shift: i % 3 === 1 ? 1 : 0, active: i < 13, hired: `${d.getFullYear()}-${mm}-${dd}`,
      contact: `09${['17', '18', '19', '16'][i % 4]} ${pad(120 + i * 53)} ${String(1000 + i * 731).slice(-4)}` });
  });
  return o;
}
const SEED = { username: 'admin', password: 'admin123', pin: '123456', business: 'InfusoPay Café', name: 'Maria Santos' };

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const fmtTime = d => new Date(d).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
const go = h => { if (location.hash === '#/' + h) route(); else location.hash = '#/' + h; };

let sess = null, pending = null, stage = 2, stream = null, camToken = 0, raf = null, lastScan = { c: null, t: 0 };

/* ---------- Demo data ---------- */
Object.assign(EMP, store.get('emps', null) || defaultEmps());
const saveEmps = () => store.set('emps', EMP);
const activeIds = () => Object.keys(EMP).filter(id => EMP[id].active);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------- Schedules: data (per-day overrides; everything else follows the default shift) ---------- */
const SHIFT_TYPES = { morning: { label: 'Morning', in: 480, out: 1020 }, afternoon: { label: 'Afternoon', in: 600, out: 1140 }, night: { label: 'Night', in: 900, out: 1440 } };
const TYPE_BY_SHIFT = ['morning', 'afternoon', 'night'];
const TYPE_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night', off: 'Day off', leave: 'On leave' };
const SCH = store.get('sched', {}); // { 'YYYY-MM-DD': { 'EMP-001': { t, in, out } } }
const saveSch = () => store.set('sched', SCH);
const dkey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function getSched(id, d) {
  const o = SCH[dkey(d)]?.[id]; if (o) return o;
  const wd = (d.getDay() + 6) % 7; // Mon = 0
  if (wd === (+id.slice(4) - 1) % 7) return { t: 'off' }; // default: one weekly day off, staggered
  const t = TYPE_BY_SHIFT[EMP[id].shift] || 'morning', p = SHIFT_TYPES[t];
  return { t, in: p.in, out: p.out };
}
const startOf = id => getSched(id, new Date()).in ?? 1e9; // scheduled start today (minutes), or 1e9 when not working
const fmtMin = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const fmtShort = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`; };
const schedText = id => { const s = getSched(id, new Date()); return s.in != null ? `${fmtMin(s.in)} – ${fmtMin(s.out)}` : TYPE_LABEL[s.t] + ' today'; };
const HIST = [[12, 2, 1], [13, 1, 1], [11, 3, 1], [13, 2, 0], [10, 2, 3], [12, 1, 2]]; // previous 6 days: [on time, late, absent]
const OFFSETS = [-10, -5, 0, 3, -2, 20, -8, 5, -1, 25, 2]; // minutes vs shift start; first 11 employees are already in today
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
  try { localStorage.setItem('theme', next); } catch (e) {}
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
$('#forgot').addEventListener('click', () => toast('Password reset isn’t available in this prototype.', 'err'));

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

$('#logout').addEventListener('click', () => { sess = null; go('login'); });
$('#home-out').addEventListener('click', () => { sess = null; go('login'); });
$('#switch').addEventListener('click', () => go('home'));

/* ---------- Camera ---------- */
function stopCam() {
  camToken++; cancelAnimationFrame(raf);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $$('video').forEach(v => { v.srcObject = null; v.classList.add('hidden'); });
  $('#qframe').classList.add('hidden'); $('#fframe').classList.add('hidden'); $('#rframe').classList.add('hidden');
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
  if (!EMP[code]) { toast('Unrecognized employee ID.', 'err'); return; }
  if (EMP[code].draft) { toast(EMP[code].name + '’s setup isn’t complete yet. Ask your manager.', 'err'); return; }
  if (!EMP[code].active) { toast(EMP[code].name + ' is inactive.', 'err'); return; }
  const sc = getSched(code, new Date()); // no shift today (day off / leave): block time in, but still allow time out for someone already clocked in
  if (sc.in == null && nextType(code) === 'in') { toast(`${EMP[code].name} isn’t scheduled today (${TYPE_LABEL[sc.t]}). Ask your manager to update the schedule.`, 'err'); return; }
  pending = code; go('verify');
}
$('#manual').addEventListener('submit', e => { e.preventDefault(); handleCode($('#mid').value.trim().toUpperCase()); $('#mid').value = ''; });

/* ---------- Verify & confirm ---------- */
const logs = () => store.get('logs', []);
const nextType = id => { const l = logs().filter(x => x.id === id).pop(); return l && l.type === 'in' ? 'out' : 'in'; };

function setStage(n) {
  stage = n;
  const label = nextType(pending) === 'in' ? 'time in' : 'time out';
  $('#s3').classList.toggle('on', n === 3);
  $('#s2').textContent = n === 3 ? '✓' : '2';
  $('#vt').textContent = n === 3 ? 'Confirm attendance' : 'Verify your identity';
  $('#vs').textContent = n === 3 ? `Identity verified. Confirm to record your ${label}.` : 'QR code scanned. Look at the camera.';
  $('#vbtn').disabled = false;
  $('#vbtn').textContent = n === 3 ? `Confirm ${label}` : 'Verify identity';
}
async function startVerify() {
  const e = EMP[pending];
  $('#av').textContent = initials(e.name); $('#en').textContent = e.name; $('#ei').textContent = pending;
  $('#ep').textContent = e.pos; $('#es').textContent = schedText(pending);
  setStage(2);
  await cam($('#fv'), 'user', $('#fmsg'), $('#fframe'));
}
$('#vbtn').addEventListener('click', () => {
  if (stage === 2) { // face verification is simulated in this prototype
    $('#vbtn').disabled = true; $('#vbtn').textContent = 'Verifying…';
    setTimeout(() => setStage(3), 1200); return;
  }
  const type = nextType(pending), e = EMP[pending], now = Date.now();
  const l = logs(); l.push({ id: pending, name: e.name, type, ts: now }); store.set('logs', l);
  toast(`${e.name}: Time ${type} at ${fmtTime(now)}`);
  pending = null; go('scan');
});

/* ---------- Dashboard ---------- */
function renderDash() {
  $('#d-biz').textContent = sess.business; $('#d-av').textContent = initials(sess.name);
  $('#d-hi').textContent = 'Hello, ' + sess.name.split(' ')[0] + '!';
  const today = new Date().toDateString();
  const t = logs().filter(x => new Date(x.ts).toDateString() === today);
  const present = [...new Set(t.filter(x => x.type === 'in' && EMP[x.id] && EMP[x.id].active).map(x => x.id))];
  const late = present.filter(id => {
    const d = new Date(t.find(x => x.id === id && x.type === 'in').ts);
    return d.getHours() * 60 + d.getMinutes() > startOf(id) + 15; // 15-min grace after scheduled start
  }).length;
  const total = activeIds().length;
  const absent = activeIds().filter(id => startOf(id) < 1e8 && !present.includes(id)).length;
  renderChart([present.length - late, late, absent]);
  $('#stats').innerHTML = [['Active employees', total], ['Present today', present.length], ['Absent today', absent], ['Late today', late]]
    .map(([l, n]) => `<div class="card p-4"><div class="text-2xl font-semibold">${n}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
  const BADGE = { present: ['b-ok', 'Present'], late: ['b-warn', 'Late'], absent: ['b-err', 'Absent'], off: ['b-muted', 'Day off'] };
  $('#rows').innerHTML = Object.entries(EMP).filter(([, e]) => e.active).map(([id, e]) => {
    const f = t.find(x => x.id === id && x.type === 'in'); // first time in today
    const d = f && new Date(f.ts);
    const st = !f ? (startOf(id) > 1e8 ? 'off' : 'absent') : d.getHours() * 60 + d.getMinutes() > startOf(id) + 15 ? 'late' : 'present';
    return `<tr class="border-t hair"><td class="py-2">${id}</td><td>${esc(e.name)}</td><td>${f ? fmtTime(f.ts) : '—'}</td><td><span class="badge ${BADGE[st][0]}">${BADGE[st][1]}</span></td></tr>`;
  }).join('');
}
$('#bell').addEventListener('click', () => toast('No new notifications.'));

/* ---------- Chart: last 7 days, stacked bars (inline SVG, no library) ---------- */
function renderChart(todayData) {
  const total = Math.max(15, activeIds().length), data = [...HIST, todayData], days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toLocaleDateString('en-US', { weekday: 'short' })); }
  const W = 420, H = 190, pl = 28, pb = 24, pt = 8, bw = 30, gap = (W - pl - 7 * bw) / 7, sy = v => (H - pb - pt) * v / total;
  let s = '';
  Array.from({ length: Math.floor(total / 5) + 1 }, (_, k) => k * 5).forEach(v => { const y = H - pb - sy(v); s += `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`; });
  data.forEach(([p, l, a], i) => {
    const x = pl + gap / 2 + i * (bw + gap); let y = H - pb;
    s += `<g><title>${days[i]}: ${p} on time, ${l} late, ${a} absent</title>`;
    [[p, 'var(--ok)'], [l, 'var(--warn)'], [a, 'var(--err)']].forEach(([v, c]) => { const h = sy(v); y -= h; s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${c}" rx="2"/>`; });
    s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${days[i]}</text></g>`;
  });
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="Attendance over the last 7 days">${s}</svg>`;
}
$('#reset').addEventListener('click', () => {
  Object.keys(SCH).forEach(k => delete SCH[k]); saveSch();
  Object.keys(EMP).forEach(k => delete EMP[k]); Object.assign(EMP, defaultEmps()); saveEmps();
  resetPay(); pSel.clear(); hSel = null;
  store.set('logs', seedLogs()); DED.length = 0; DED.push(...seedDeds()); saveDed(); route(); toast('Demo data reset.');
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

/* ---------- Employees page ---------- */
const fmtDate = s => new Date(s + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
$('#f-shift').innerHTML = SHIFTS.map((s, i) => `<option value="${i}">${s[1]}</option>`).join('');

const eSel = new Set(), cardOk = id => !!EMP[id] && EMP[id].active && !EMP[id].draft; // ID cards: active employees with completed setup
function renderEmployees() {
  const all = Object.entries(EMP), act = all.filter(([, e]) => e.active).length;
  $('#emp-stats').innerHTML = [['Total employees', all.length], ['Active employees', act], ['Inactive employees', all.length - act]]
    .map(([l, n]) => `<div class="card p-4"><div class="text-2xl font-semibold">${n}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
  const cur = $('#e-pos').value, poss = [...new Set(all.map(([, e]) => e.pos))].sort();
  $('#e-pos').innerHTML = '<option value="">All positions</option>' + poss.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#e-pos').value = poss.includes(cur) ? cur : '';
  const q = $('#e-q').value.trim().toLowerCase(), pf = $('#e-pos').value, sf = $('#e-st').value;
  const rows = all.filter(([id, e]) => (!q || `${id} ${e.name} ${e.pos}`.toLowerCase().includes(q)) && (!pf || e.pos === pf) && (!sf || (sf === 'active') === e.active));
  $('#emp-rows').innerHTML = rows.length ? rows.map(([id, e], i) => `<tr class="border-t hair">
    <td class="py-2.5 pr-3"><input type="checkbox" data-csel="${id}" ${eSel.has(id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></td><td class="py-2.5 muted">${i + 1}</td>
    <td class="whitespace-nowrap">${e.photo ? `<img class="avatar mr-2 align-middle inline-block" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs mr-2 align-middle" style="background:var(--bg)">${initials(e.name)}</span>`}${id}</td>
    <td>${esc(e.name)}</td><td>${esc(e.pos)}</td><td class="whitespace-nowrap">${esc(e.contact || '—')}</td><td class="whitespace-nowrap">${fmtDate(e.hired)}</td>
    <td><span class="badge ${e.draft ? 'b-warn' : e.active ? 'b-ok' : 'b-err'}">${e.draft ? 'Draft' : e.active ? 'Active' : 'Inactive'}</span></td>
    <td class="whitespace-nowrap"><button class="ghost !py-1 !px-2 text-xs" data-card="${id}" ${cardOk(id) ? '' : 'disabled title="Activate the employee to issue an ID card"'}>ID card</button> <button class="ghost !py-1 !px-2 text-xs" data-edit="${id}">Edit</button> <button class="ghost !py-1 !px-2 text-xs" style="color:var(--err)" data-del="${id}">Delete</button></td></tr>`).join('')
    : '<tr class="border-t hair"><td colspan="9" class="py-8 text-center muted">No employees match your filters.</td></tr>';
  $('#emp-count').textContent = `Showing ${rows.length} of ${all.length} employees`;
  $('#e-all').checked = rows.length > 0 && rows.every(([id]) => eSel.has(id));
}
['#e-q', '#e-pos', '#e-st'].forEach(s => $(s).addEventListener('input', renderEmployees));

/* ---------- Add / edit employee wizard ---------- */
const POSITIONS = ['Barista', 'Cashier', 'Kitchen staff', 'Server', 'Dishwasher'];
const LABELS = { 1: 'Continue to Face Registration →', 2: 'Continue to Review →', 3: 'Generate ID & save' };
const modal = $('#emp-modal');
let editId = null, W = null;
const nextEmpId = () => 'EMP-' + pad(Math.max(0, ...Object.keys(EMP).map(k => +k.slice(4))) + 1);
const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });

function paintPhoto() {
  $('#p-prev').innerHTML = W.photo ? `<img src="${W.photo}" alt="Employee photo">` : 'No photo';
  $('#p-rm').disabled = !W.photo;
}
function paintFace() { $('#f-face').textContent = W.face ? '✓ Face registered' : 'Not registered yet'; }

function setWiz(n) {
  stopCam(); W.step = n;
  $$('#emp-form [data-step]').forEach(s => s.classList.toggle('hidden', +s.dataset.step !== n));
  $$('#emp-form [data-dot]').forEach(d => { const k = +d.dataset.dot; d.classList.toggle('on', k <= n); d.textContent = k < n ? '✓' : k; });
  $$('#emp-form [data-lbl]').forEach(l => l.style.color = +l.dataset.lbl === n ? 'var(--text)' : '');
  $('#emp-sub').textContent = ['Fill in the details below to add a new employee.', 'Register the employee’s face for attendance.', 'Check everything, then generate the employee ID.'][n - 1];
  $('#f-back').classList.toggle('hidden', n === 1);
  $('#f-next').textContent = LABELS[n];
  if (n === 2) { paintFace(); cam($('#rv'), 'user', $('#rmsg'), $('#rframe')); }
  if (n === 3) {
    $('#f-sum').innerHTML = [['Employee ID', W.id], ['Name', W.name], ['Position', W.pos], ['Rate per hour', peso(W.rate)], ['Date hired', fmtDate(W.hired)], ['Face', W.face ? 'Registered' : 'Not registered']]
      .map(([k, v]) => `<div class="flex justify-between border-b hair pb-2"><dt class="muted">${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#f-idbig').textContent = W.id;
    $('#f-qr').innerHTML = typeof qrcode === 'undefined' ? '' : qrSvg(W.id);
  }
}

function readStep1() {
  const v = { name: $('#f-name').value.trim(), pos: $('#f-pos').value, rate: parseFloat($('#f-rate').value), hired: $('#f-hired').value };
  if (!v.name || !v.pos || !(v.rate > 0) || !v.hired) { toast('Enter the name, position, rate and date hired.', 'err'); return false; }
  Object.assign(W, v); return true;
}

function openEmp(id) {
  editId = id || null;
  const e = id ? EMP[id] : { name: '', pos: '', rate: '', hired: new Date().toISOString().slice(0, 10), shift: 0, active: true, contact: '', photo: '', face: false };
  W = { step: 1, id: id || nextEmpId(), photo: e.photo || '', face: !!e.face };
  const opts = [...new Set([...POSITIONS, ...(e.pos ? [e.pos] : [])])];
  $('#f-pos').innerHTML = '<option value="">Select position</option>' + opts.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#emp-title').textContent = id ? `Edit ${id}` : 'Add Employee';
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
    name: W.name, pos: W.pos, rate: W.rate, hired: W.hired, photo: W.photo, face: W.face, draft,
    contact: $('#f-contact').value.trim(), shift: +$('#f-shift').value,
    active: draft ? false : (editId ? old.active !== false || old.draft === true : true),
  });
  saveEmps(); closeEmp(); renderEmployees();
  toast(draft ? `Draft saved as ${W.id}.` : editId ? 'Employee updated.' : `Employee added as ${W.id}.`);
}

$('#add-emp').addEventListener('click', () => openEmp());
$('#f-x').addEventListener('click', closeEmp);
addEventListener('keydown', e => { if (e.key === 'Escape') closeEmp(); });
$('#f-back').addEventListener('click', () => setWiz(W.step - 1));
$('#f-draft').addEventListener('click', () => saveEmp(true));
$('#f-next').addEventListener('click', () => {
  if (W.step === 1) { if (readStep1()) setWiz(2); }
  else if (W.step === 2) { if (W.face) setWiz(3); else toast('Capture the employee’s face to continue.', 'err'); }
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
$('#f-snap').addEventListener('click', () => {
  const v = $('#rv');
  if (v.videoWidth) { W.photo = squareThumb(v, v.videoWidth, v.videoHeight); paintPhoto(); }
  W.face = true; paintFace(); // registration is simulated; works without a camera too
});

$('#emp-rows').addEventListener('click', e => {
  const k = e.target.closest('[data-csel]'); if (k) { k.checked ? eSel.add(k.dataset.csel) : eSel.delete(k.dataset.csel); return; }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.card) { if (!b.disabled) openCard(b.dataset.card); return; }
  if (b.dataset.edit) EMP[b.dataset.edit].draft ? openEmp(b.dataset.edit) : openEdit(b.dataset.edit); // drafts resume setup; existing employees get the edit form
  if (b.dataset.del && confirm(`Delete ${EMP[b.dataset.del].name} (${b.dataset.del})? This can’t be undone.`)) {
    delete EMP[b.dataset.del]; saveEmps(); renderEmployees(); toast('Employee deleted.');
  }
});
/* ---------- Edit existing employee (ID, hire date and face registration are read-only) ---------- */
const eModal = $('#edit-modal');
let xId = null, xPhoto = '';
$('#x-shift').innerHTML = $('#f-shift').innerHTML;
function paintX() {
  $('#x-prev').innerHTML = xPhoto ? `<img src="${xPhoto}" alt="Employee photo" class="w-full h-full object-cover">` : esc(initials(EMP[xId].name));
  $('#x-rm').disabled = !xPhoto;
}
function openEdit(id) {
  xId = id; const e = EMP[id]; xPhoto = e.photo || '';
  $('#x-info').innerHTML = [['Employee ID', id], ['Date hired', fmtDate(e.hired)], ['Face', e.face ? 'Registered' : 'Not registered']]
    .map(([k, v]) => `<div><dt class="muted text-xs">${k}</dt><dd class="mt-0.5">${esc(v)}</dd></div>`).join('');
  const opts = [...new Set([...POSITIONS, e.pos])];
  $('#x-pos').innerHTML = opts.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#x-name').value = e.name; $('#x-pos').value = e.pos; $('#x-rate').value = e.rate || '';
  $('#x-shift').value = e.shift; $('#x-contact').value = e.contact || ''; $('#x-status').value = e.active ? 'active' : 'inactive';
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
  EMP[xId] = withShift({ ...EMP[xId], name, pos: $('#x-pos').value, rate, contact: $('#x-contact').value.trim(),
    shift: +$('#x-shift').value, active: $('#x-status').value === 'active', photo: xPhoto });
  saveEmps(); closeEdit(); renderEmployees(); toast('Employee updated.');
});

/* ---------- ID cards ---------- */
const bizName = () => (typeof sess !== 'undefined' && sess && sess.business) || 'InfusoPay Café';
const cardFront = id => { const e = EMP[id]; return `<div class="idc"><div class="idc-h">${esc(bizName())}</div><div class="idc-b">
  <div class="idc-p">${e.photo ? `<img src="${e.photo}" alt="">` : esc(initials(e.name))}</div>
  <div class="idc-t"><div class="idc-n">${esc(e.name)}</div><div class="idc-s">${esc(e.pos)}</div><div class="idc-i">${id}</div></div>
  <div class="idc-q">${typeof qrcode === 'undefined' ? '' : qrSvg(id)}</div></div>
  <div class="idc-f"><span>Employee ID card</span><span>Scan for attendance</span></div></div>`; };
const cardBack = id => `<div class="idc"><div class="idc-h">${esc(bizName())}</div><div class="idc-bk">
  <p>This card is the property of ${esc(bizName())}. It is non-transferable and must be shown when requested.</p>
  <p>Scan the QR code at the attendance station to record your time in and out.</p>
  <p>If found, please return it to ${esc(bizName())}, Bulacan.</p></div><div class="idc-f"><span>${id}</span><span>Report a lost card to your manager</span></div></div>`;
const cardModal = $('#card-modal'); let cardId = null;
function openCard(id) { cardId = id; $('#cm-body').innerHTML = cardFront(id) + cardBack(id); cardModal.classList.remove('hidden'); cardModal.classList.add('flex'); }
const closeCard = () => { cardModal.classList.add('hidden'); cardModal.classList.remove('flex'); };
function printCards(ids) {
  const ok = ids.filter(cardOk);
  if (!ok.length) { toast('ID cards are only issued to active employees with completed setup.', 'err'); return; }
  if (ok.length < ids.length) toast(`Skipped ${ids.length - ok.length} inactive or draft employee${ids.length - ok.length === 1 ? '' : 's'}.`, 'err');
  $('#card-sheet').innerHTML = ok.map(id => cardFront(id) + cardBack(id)).join('');
  window.print();
}
addEventListener('afterprint', () => { $('#card-sheet').innerHTML = ''; });
$('#cm-x').addEventListener('click', closeCard); $('#cm-close').addEventListener('click', closeCard);
addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });
$('#cm-print').addEventListener('click', () => printCards([cardId]));
$('#print-cards').addEventListener('click', () => eSel.size ? printCards([...eSel]) : toast('Select employees first.', 'err'));
$('#e-all').addEventListener('change', e => { $$('#emp-rows [data-csel]').forEach(k => { k.checked = e.target.checked; e.target.checked ? eSel.add(k.dataset.csel) : eSel.delete(k.dataset.csel); }); });

/* ---------- Schedules: page ---------- */
const mondayOf = d => { const m = new Date(d); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toTime = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
let wk = mondayOf(new Date()), sEdit = null;

function renderSchedule() {
  const days = [...Array(7)].map((_, i) => addDays(wk, i)), a = days[0], b = days[6], todayK = dkey(new Date());
  $('#s-range').textContent = a.getMonth() === b.getMonth()
    ? `${a.toLocaleDateString('en-US', { month: 'long' })} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`
    : `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`;
  const staff = Object.entries(EMP).filter(([, e]) => e.active && !e.draft);
  const cur = $('#s-pos').value, poss = [...new Set(staff.map(([, e]) => e.pos))].sort();
  $('#s-pos').innerHTML = '<option value="">All positions</option>' + poss.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#s-pos').value = poss.includes(cur) ? cur : '';
  const q = $('#s-q').value.trim().toLowerCase(), pf = $('#s-pos').value;
  const rows = staff.filter(([id, e]) => (!q || `${id} ${e.name}`.toLowerCase().includes(q)) && (!pf || e.pos === pf));
  $('#s-head').innerHTML = '<tr><th class="text-left font-normal muted py-2 sticky left-0 z-10" style="background:var(--surface)">Employee</th>' + days.map(d => {
    const t = dkey(d) === todayK;
    return `<th class="font-normal text-center py-1"><div class="${t ? 'font-medium' : 'muted'}">${d.toLocaleDateString('en-US', { weekday: 'short' })}</div><div class="text-xs mt-0.5 ${t ? 'inline-grid place-items-center w-6 h-6 rounded-full' : 'muted'}" ${t ? 'style="background:var(--accent);color:var(--ink)"' : ''}>${d.getDate()}</div></th>`;
  }).join('') + '</tr>';
  $('#s-rows').innerHTML = rows.length ? rows.map(([id, e]) => `<tr><td class="sticky left-0 z-10 pr-3 py-1 whitespace-nowrap" style="background:var(--surface)">
    <div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}
    <div class="leading-tight"><div class="font-medium">${esc(e.name)}</div><div class="muted text-xs">${esc(e.pos)}</div></div></div></td>` + days.map(d => {
      const s = getSched(id, d);
      return `<td class="p-0 align-top min-w-[112px]"><button type="button" class="sc sc-${s.t}" data-id="${id}" data-d="${dkey(d)}"><b>${TYPE_LABEL[s.t]}</b>${s.in != null ? `<span class="muted">${fmtShort(s.in)} – ${fmtShort(s.out)}</span>` : ''}</button></td>`;
    }).join('') + '</tr>').join('') : '<tr><td colspan="8" class="py-8 text-center muted">No employees match your filters.</td></tr>';
}
$('#s-prev').addEventListener('click', () => { wk = addDays(wk, -7); renderSchedule(); });
$('#s-next').addEventListener('click', () => { wk = addDays(wk, 7); renderSchedule(); });
$('#s-today').addEventListener('click', () => { wk = mondayOf(new Date()); renderSchedule(); });
['#s-q', '#s-pos'].forEach(s => $(s).addEventListener('input', renderSchedule));

const sModal = $('#sch-modal');
const paintWork = () => $('#s-work').classList.toggle('hidden', $('#s-status').value !== 'work');
function openSch(id, key) {
  const d = new Date(key + 'T00:00'), s = getSched(id, d), e = EMP[id];
  sEdit = { id, key };
  $('#s-info').innerHTML = [['Employee', esc(e.name)], ['Date', d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })]]
    .map(([k, v]) => `<div class="flex justify-between"><dt class="muted">${k}</dt><dd>${v}</dd></div>`).join('');
  const t = s.in != null ? s.t : (TYPE_BY_SHIFT[e.shift] || 'morning'), p = SHIFT_TYPES[t];
  $('#s-status').value = s.in != null ? 'work' : s.t;
  $('#s-type').value = t; $('#s-in').value = toTime(s.in ?? p.in); $('#s-out').value = toTime(s.out ?? p.out);
  paintWork(); sModal.classList.remove('hidden'); sModal.classList.add('flex');
}
const closeSch = () => { sModal.classList.add('hidden'); sModal.classList.remove('flex'); };
$('#s-rows').addEventListener('click', e => { const b = e.target.closest('.sc'); if (b) openSch(b.dataset.id, b.dataset.d); });
$('#s-status').addEventListener('change', paintWork);
$('#s-type').addEventListener('change', () => { const p = SHIFT_TYPES[$('#s-type').value]; $('#s-in').value = toTime(p.in); $('#s-out').value = toTime(p.out); });
$('#s-x').addEventListener('click', closeSch); $('#s-cancel').addEventListener('click', closeSch);
addEventListener('keydown', e => { if (e.key === 'Escape') closeSch(); });
$('#s-form').addEventListener('submit', e => {
  e.preventDefault();
  const st = $('#s-status').value; let v;
  if (st === 'work') {
    if (!$('#s-in').value || !$('#s-out').value) { toast('Enter the time in and time out.', 'err'); return; }
    const i = toMin($('#s-in').value); let o = toMin($('#s-out').value); if (o <= i) o += 1440; // ends after midnight
    v = { t: $('#s-type').value, in: i, out: o };
  } else v = { t: st };
  (SCH[sEdit.key] = SCH[sEdit.key] || {})[sEdit.id] = v; saveSch(); closeSch(); renderSchedule(); toast('Schedule updated.');
});

/* ---------- Attendance records ---------- */
const PER_PAGE = 10, GRACE = 15;
let aMode = 'today', aPage = 1;
const hsh = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const fmtHM = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h${mm ? ' ' + String(mm).padStart(2, '0') + 'm' : ''}` : mm ? mm + 'm' : '0h'; };
const schedShort = s => `${fmtShort(s.in).replace(' ', '')}–${fmtShort(s.out).replace(' ', '')}`;
const ATT_BADGE = { present: ['b-ok', 'Present'], late: ['b-warn', 'Late'], absent: ['b-err', 'Absent'], upcoming: ['b-muted', 'Upcoming'], off: ['b-muted', 'Day off'], leave: ['b-muted', 'On leave'] };
const minOf = t => { const q = new Date(t); return q.getHours() * 60 + q.getMinutes(); };

function attRecord(id, d) {
  const key = dkey(d), s = getSched(id, d), isToday = key === dkey(new Date()), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const r = { id, e: EMP[id], d, s, tin: null, tout: null, running: false, hrs: 0, ot: 0 };
  if (s.in == null) return { ...r, st: s.t };
  if (isToday) {
    const L = logs().filter(x => x.id === id && dkey(new Date(x.ts)) === key), f = L.find(x => x.type === 'in');
    if (f) { r.tin = minOf(f.ts); const last = L[L.length - 1]; if (last.type === 'out') r.tout = minOf(last.ts); }
  } else if (hsh(id + key) % 100 >= 7) { // demo history: deterministic, so the same day always shows the same record
    r.tin = s.in + (hsh(key + id) % 35) - 12; r.tout = s.out + (hsh(id + 'o' + key) % 30) - 12;
  }
  if (r.tin == null) return { ...r, st: isToday && nowMin < s.in ? 'upcoming' : 'absent' };
  if (r.tout != null && r.tout < r.tin) r.tout += 1440; // out after midnight
  r.running = isToday && r.tout == null;
  r.hrs = (r.tout ?? nowMin) - r.tin; r.ot = r.tout != null ? Math.max(0, r.tout - s.out) : 0;
  r.st = r.tin > s.in + GRACE ? 'late' : 'present';
  return r;
}
function attDates() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  if (aMode === 'today') return [now];
  if (aMode === 'date') return [new Date($('#a-date').value + 'T00:00')];
  const start = aMode === 'week' ? mondayOf(now) : new Date(now.getFullYear(), now.getMonth(), 1), out = [];
  for (let d = new Date(now); d >= start; d = addDays(d, -1)) out.push(new Date(d));
  return out;
}
function renderAttendance() {
  const multi = aMode === 'week' || aMode === 'month', todayK = dkey(new Date());
  if (aMode !== 'date') $('#a-date').value = ''; $('#a-date').max = todayK;
  $$('#a-modes button').forEach(b => b.className = b.dataset.mode === aMode ? 'btn text-sm' : 'ghost text-sm');
  const staff = Object.entries(EMP).filter(([, e]) => e.active && !e.draft);
  const cur = $('#a-pos').value, poss = [...new Set(staff.map(([, e]) => e.pos))].sort();
  $('#a-pos').innerHTML = '<option value="">All Positions</option>' + poss.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#a-pos').value = poss.includes(cur) ? cur : '';
  const q = $('#a-q').value.trim().toLowerCase(), pf = $('#a-pos').value, sf = $('#a-st').value, dates = attDates();
  $('#a-label').textContent = multi ? `${dates[dates.length - 1].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${dates[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : dates[0].toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const recs = [];
  dates.forEach(d => staff.forEach(([id, e]) => {
    if (d < new Date(e.hired + 'T00:00') || (pf && e.pos !== pf) || (q && !`${id} ${e.name}`.toLowerCase().includes(q))) return;
    const r = attRecord(id, d); if (!sf || r.st === sf) recs.push(r);
  }));
  const pages = Math.max(1, Math.ceil(recs.length / PER_PAGE)); aPage = Math.min(aPage, pages);
  const from = (aPage - 1) * PER_PAGE, part = recs.slice(from, from + PER_PAGE);
  $('#a-head').innerHTML = ['ID', 'Employee', ...(multi ? ['Date'] : []), 'Scheduled', 'Time In', 'Time Out', 'Hours', 'OT', 'Status'].map(h => `<th class="py-2 font-normal pr-3">${h}</th>`).join('');
  $('#a-rows').innerHTML = part.length ? part.map(r => {
    const w = r.s.in != null, b = ATT_BADGE[r.st];
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${r.id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${r.e.photo ? `<img class="avatar" src="${r.e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(r.e.name)}</span>`}<div class="leading-tight"><div>${esc(r.e.name)}</div><div class="muted text-xs">${esc(r.e.pos)}</div></div></div></td>
    ${multi ? `<td class="pr-3 whitespace-nowrap">${r.d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>` : ''}
    <td class="pr-3 whitespace-nowrap">${w ? schedShort(r.s) : '—'}</td>
    <td class="pr-3 whitespace-nowrap">${r.tin != null ? fmtMin(r.tin) : '—'}</td>
    <td class="pr-3 whitespace-nowrap">${r.tout != null ? fmtMin(r.tout) : '—'}</td>
    <td class="pr-3 whitespace-nowrap ${r.running ? 'muted' : ''}" ${r.running ? 'title="Still clocked in"' : ''}>${fmtHM(r.hrs)}</td>
    <td class="pr-3 whitespace-nowrap">${fmtHM(r.ot)}</td>
    <td><span class="badge ${b[0]}">${b[1]}</span></td></tr>`;
  }).join('') : `<tr class="border-t hair"><td colspan="${multi ? 9 : 8}" class="py-8 text-center muted">No attendance records match your filters.</td></tr>`;
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
   Automatic: Tardiness + Undertime are DERIVED from attendRecord() (Attendance + Schedule), never stored,
   so they always match the Attendance page. Manual: Cash Advance, Uniform Fee, Lost ID, Other are stored.
   Absences are NOT deducted: payroll pays only hours worked (avoids double-deducting). */
const DEF_RATE = 80, UNDER_GRACE = 5, MAX_DAYS = 92; // fallback ₱/hr for employees without a rate; undertime grace (min); max range
const DED_TYPES = { tardiness: 'Tardiness', undertime: 'Undertime', advance: 'Cash Advance', uniform: 'Uniform Fee', lostid: 'Lost ID', other: 'Other' };
const DED_MANUAL = ['advance', 'uniform', 'lostid', 'other'];
const DED_BADGE = { tardiness: 'b-err', undertime: 'b-warn', advance: 'b-night', uniform: 'b-muted', lostid: 'b-err', other: 'b-muted' };
const rateOf = id => EMP[id]?.rate > 0 ? EMP[id].rate : DEF_RATE;
const dedAmt = (id, mins) => Math.round(rateOf(id) / 60 * mins * 100) / 100; // hourly rate ÷ 60 × minutes
const num = n => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const seedDeds = () => [['EMP-002', 'advance', 450, 'Salary advance', 1], ['EMP-005', 'uniform', 100, 'Uniform fee', 2], ['EMP-010', 'lostid', 150, 'Lost ID', 3], ['EMP-004', 'advance', 300, 'Salary advance', 4], ['EMP-007', 'other', 200, 'Approved deduction', 6]]
  .map(([id, type, amount, remarks, ago], i) => ({ k: 'm-' + (i + 1), id, type, amount, remarks, date: dkey(addDays(new Date(), -ago)) }));
const DED = store.get('deds', null) || seedDeds();
const saveDed = () => store.set('deds', DED);

function autoDeds(from, to) {
  const out = [];
  for (let d = new Date(to); d >= from; d = addDays(d, -1)) Object.entries(EMP).forEach(([id, e]) => {
    if (!e.active || e.draft || d < new Date(e.hired + 'T00:00')) return;
    const r = attRecord(id, d), date = dkey(d);
    if (r.st === 'late') { const m = r.tin - r.s.in; out.push({ k: `a-${id}-${date}-t`, auto: true, date, id, type: 'tardiness', amount: dedAmt(id, m), remarks: `Late by ${m} minute${m === 1 ? '' : 's'}` }); }
    if (r.tout != null && r.s.out - r.tout > UNDER_GRACE) { const m = r.s.out - r.tout; out.push({ k: `a-${id}-${date}-u`, auto: true, date, id, type: 'undertime', amount: dedAmt(id, m), remarks: `Undertime (${fmtHM(m)})` }); }
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
const dpager = (page, pages) => { const n = []; for (let p = Math.max(1, page - 2); p <= Math.min(pages, Math.max(page + 2, 5)); p++) n.push(p);
  return `<button class="ghost !px-3" data-p="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>` + n.map(p => `<button class="${p === page ? 'btn' : 'ghost'} !px-3" data-p="${p}">${p}</button>`).join('') + `<button class="ghost !px-3" data-p="${page + 1}" ${page === pages ? 'disabled' : ''} aria-label="Next page">›</button>`; };

function renderDeductions() {
  const custom = $('#d-per').value === 'custom', today = dkey(new Date());
  $('#d-from').classList.toggle('hidden', !custom); $('#d-to').classList.toggle('hidden', !custom); $('#d-from').max = $('#d-to').max = today;
  const [from, to] = dedRange(), fk = dkey(from), tk = dkey(to);
  if (custom) { if (!$('#d-from').value) $('#d-from').value = fk; if (!$('#d-to').value) $('#d-to').value = tk; }
  const curE = $('#d-emp').value, emps = Object.entries(EMP).filter(([, e]) => !e.draft);
  $('#d-emp').innerHTML = '<option value="">All Employees</option>' + emps.map(([id, e]) => `<option value="${id}">${esc(e.name)}</option>`).join('');
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
  $('#d-rows').innerHTML = part.length ? part.map(x => { const e = EMP[x.id];
    return `<tr class="border-t hair"><td class="py-2.5 pr-3 whitespace-nowrap">${fmtDate(x.date)}</td><td class="pr-3 whitespace-nowrap">${x.id}</td>
    <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
    <td class="pr-3 whitespace-nowrap">${esc(e.pos)}</td><td class="pr-3"><span class="badge ${DED_BADGE[x.type]}">${DED_TYPES[x.type]}</span></td>
    <td class="pr-3 whitespace-nowrap">${num(x.amount)}</td><td class="pr-3">${esc(x.remarks || '—')}</td><td class="pr-3"><span class="badge b-ok">Applied</span></td>
    <td class="whitespace-nowrap">${x.auto ? '<span class="muted text-xs" title="Generated from Attendance and Schedules">Automatic</span>' : `<button class="ghost !py-1 !px-2 text-xs" data-dedit="${x.k}">Edit</button> <button class="ghost !py-1 !px-2 text-xs" style="color:var(--err)" data-ddel="${x.k}">Delete</button>`}</td></tr>`; }).join('')
    : '<tr class="border-t hair"><td colspan="9" class="py-8 text-center muted">No deductions match your filters.</td></tr>';
  $('#d-count').textContent = all.length ? `Showing ${at + 1} to ${at + part.length} of ${all.length} records` : 'Showing 0 records';
  $('#d-pager').innerHTML = dpager(dPage, pages);
  $('#d-note').textContent = `Tardiness (late beyond ${GRACE} min) and undertime (over ${UNDER_GRACE} min) are generated from Attendance and Schedules: hourly rate ÷ 60 × minutes (₱${DEF_RATE}/hr if no rate is set). Absent days are unpaid. On days worked, payroll pays the scheduled hours and these deductions adjust for lateness and undertime.`;
}
$('#d-type').innerHTML = '<option value="">All Deduction Types</option>' + Object.entries(DED_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#dm-type').innerHTML = DED_MANUAL.map(k => `<option value="${k}">${DED_TYPES[k]}</option>`).join('');
['#d-per', '#d-from', '#d-to', '#d-emp', '#d-type', '#d-q'].forEach(s => $(s).addEventListener('input', () => { dPage = 1; renderDeductions(); }));
$('#d-pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { dPage = +b.dataset.p; renderDeductions(); } });

const dModal = $('#ded-modal');
let dEdit = null;
function openDed(k) {
  dEdit = k || null; const r = k ? DED.find(x => x.k === k) : null;
  $('#dm-emp').innerHTML = '<option value="">Select employee</option>' + Object.entries(EMP).filter(([id, e]) => (e.active && !e.draft) || id === r?.id).map(([id, e]) => `<option value="${id}">${id} · ${esc(e.name)}</option>`).join('');
  $('#dm-title').textContent = r ? 'Edit deduction' : 'Add deduction';
  $('#dm-emp').value = r?.id || ''; $('#dm-type').value = r?.type || 'advance'; $('#dm-date').value = r?.date || dkey(new Date()); $('#dm-date').max = dkey(new Date());
  $('#dm-amt').value = r?.amount ?? ''; $('#dm-rem').value = r?.remarks || '';
  dModal.classList.remove('hidden'); dModal.classList.add('flex'); $('#dm-emp').focus();
}
const closeDed = () => { dModal.classList.add('hidden'); dModal.classList.remove('flex'); };
$('#add-ded').addEventListener('click', () => openDed());
$('#dm-x').addEventListener('click', closeDed); $('#dm-cancel').addEventListener('click', closeDed);
addEventListener('keydown', e => { if (e.key === 'Escape') closeDed(); });
$('#dm-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = $('#dm-emp').value, amount = Math.round(parseFloat($('#dm-amt').value) * 100) / 100, date = $('#dm-date').value;
  if (!id || !date || !(amount > 0)) { toast('Select an employee, date and an amount above zero.', 'err'); return; }
  if (date > dkey(new Date())) { toast('The date can’t be in the future.', 'err'); return; }
  const rec = { k: dEdit || 'm-' + Date.now() + Math.random().toString(36).slice(2, 5), id, type: $('#dm-type').value, amount, date, remarks: $('#dm-rem').value.trim() };
  const i = DED.findIndex(x => x.k === dEdit); if (i >= 0) DED[i] = rec; else DED.push(rec);
  saveDed(); closeDed(); renderDeductions(); toast(dEdit ? 'Deduction updated.' : 'Deduction added.');
});
$('#d-rows').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.dedit) openDed(b.dataset.dedit);
  if (b.dataset.ddel && confirm('Delete this deduction? This can’t be undone.')) { const i = DED.findIndex(x => x.k === b.dataset.ddel); if (i >= 0) DED.splice(i, 1); saveDed(); renderDeductions(); toast('Deduction deleted.'); }
});

/* ---------- Payroll ----------
   Weekly periods (Mon–Sun). A period is payable once it has ended, so the OPEN payroll is the latest completed week.
   It stays on "Current payroll" until the next week ends, then rolls into History. Processed records are frozen (SNAP). */
const PAY = store.get('pay', {}), SNAP = store.get('paysnap', {}), OT_MULT = 1.25; // overtime paid at 125%
const savePay = () => { store.set('pay', PAY); store.set('paysnap', SNAP); };
const PAY_ST = { none: ['b-muted', 'Not generated'], draft: ['b-muted', 'Draft'], review: ['b-warn', 'For review'], approved: ['b-night', 'Approved'], processed: ['b-ok', 'Processed'] };
const PAY_NEXT = { draft: ['review', 'Send for review'], review: ['approved', 'Approve'], approved: ['processed', 'Process & release payslip'] };
let pTab = 'current', pPage = 1, hPage = 1, pSel = new Set(), pOpen = null, hSel = null;
const curStart = () => addDays(mondayOf(new Date()), -7), weekEnd = s => addDays(s, 6);
const pKey = (s, id) => dkey(s) + '|' + id, pStatus = (s, id) => PAY[pKey(s, id)] || 'none';
const sd = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmR = s => `${sd(s)} – ${weekEnd(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
function payCalc(id, from, to, A) {
  const today = new Date(); today.setHours(0, 0, 0, 0); const e = EMP[id];
  const c = { days: 0, present: 0, late: 0, absent: 0, mins: 0, ot: 0, reg: 0, lates: [] };
  for (let d = new Date(from); d <= to && d <= today; d = addDays(d, 1)) {
    if (d < new Date(e.hired + 'T00:00')) continue;
    const r = attRecord(id, d); if (r.s.in == null || r.st === 'upcoming') continue;
    c.days++;
    if (r.st === 'absent') c.absent++;
    else { c.present++; c.mins += r.hrs; c.ot += r.ot; c.reg += r.s.out - r.s.in; // paid on scheduled hours; lateness and undertime are deducted separately
      if (r.st === 'late') { c.late++; c.lates.push({ d: new Date(d), tin: r.tin, sin: r.s.in }); } }
  }
  const fk = dkey(from), tk = dkey(to);
  c.ds = [...A.filter(x => x.id === id), ...DED.filter(x => x.id === id && x.date >= fk && x.date <= tk)];
  c.rate = rateOf(id); const R = m => Math.round(c.rate / 60 * m * 100) / 100;
  c.basic = R(c.reg); c.otPay = Math.round(R(c.ot) * OT_MULT * 100) / 100; c.gross = Math.round((c.basic + c.otPay) * 100) / 100;
  c.ded = c.ds.reduce((s, x) => s + x.amount, 0); c.net = Math.max(0, c.gross - c.ded);
  return c;
}
function payGet(id, s, A) { // processed records come from the frozen snapshot, everything else is live
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
  PAY[k] = n[0]; if (n[0] === 'processed') SNAP[k] = payCalc(id, s, weekEnd(s), A || autoDeds(s, weekEnd(s))); // lock the figures
  return true;
}
function resetPay() { // history: the last three closed periods are already processed, like a real payroll record
  Object.keys(PAY).forEach(k => delete PAY[k]); Object.keys(SNAP).forEach(k => delete SNAP[k]);
  [-14, -21, -28].forEach(off => {
    const s = addDays(curStart(), off), A = autoDeds(s, weekEnd(s));
    Object.keys(EMP).filter(id => EMP[id].active && !EMP[id].draft).forEach(id => { PAY[pKey(s, id)] = 'processed'; SNAP[pKey(s, id)] = payCalc(id, s, weekEnd(s), A); });
  });
  store.set('payv', 2); savePay();
}
if (store.get('payv', 0) !== 2) resetPay();

const payRowHtml = ({ id, e, c, st }, chk) => `<tr class="border-t hair">${chk ? `<td class="py-2.5 pr-3"><input type="checkbox" data-sel="${id}" ${pSel.has(id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></td>` : ''}<td class="${chk ? '' : 'py-2.5 '}pr-3 whitespace-nowrap">${id}</td>
  <td class="pr-3 whitespace-nowrap"><div class="flex items-center gap-2">${e.photo ? `<img class="avatar" src="${e.photo}" alt="">` : `<span class="inline-grid place-items-center w-7 h-7 rounded-full text-xs" style="background:var(--bg)">${initials(e.name)}</span>`}${esc(e.name)}</div></td>
  <td class="pr-3 whitespace-nowrap">${esc(e.pos)}</td><td class="pr-3">${num(c.rate)}</td><td class="pr-3 whitespace-nowrap">${fmtHM(c.mins)}</td><td class="pr-3">${num(c.gross)}</td><td class="pr-3">${num(c.ded)}</td><td class="pr-3 font-medium">${num(c.net)}</td>
  <td class="pr-3"><span class="badge ${PAY_ST[st][0]}">${PAY_ST[st][1]}</span></td>
  <td class="whitespace-nowrap"><button class="ghost !py-1 !px-2 text-xs" data-pv="${id}">View</button> <button class="ghost !py-1 !px-2 text-xs" data-ps="${id}" ${st === 'processed' ? '' : 'disabled title="Available once payroll is processed"'}>Payslip</button></td></tr>`;

function renderPayroll() {
  $$('#p-tabs button').forEach(b => b.className = b.dataset.tab === pTab ? 'btn text-sm' : 'ghost text-sm');
  const cur = pTab === 'current'; $('#p-cur').classList.toggle('hidden', !cur); $('#p-his').classList.toggle('hidden', cur);
  $('#p-gen').classList.toggle('hidden', !cur); $('#p-adv').classList.toggle('hidden', !cur);
  cur ? renderPayCur() : renderPayHis();
}
function renderPayCur() {
  const s = curStart(), nx = addDays(s, 14);
  $('#p-label').textContent = `Current payroll period: ${fmR(s)}`;
  $('#p-info').textContent = `${sd(addDays(s, 7))} – ${sd(addDays(s, 13))} is still in progress. Its payroll opens on ${nx.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, and this period then moves to History.`;
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
  $('#p-stats').innerHTML = [['Total employees', rows.length], ['Total gross pay', peso(sum('gross'))], ['Total deductions', peso(sum('ded'))], ['Total net pay', peso(sum('net'))]]
    .map(([l, v]) => `<div class="card p-4"><div class="text-2xl font-semibold">${v}</div><div class="muted text-sm mt-1">${l}</div></div>`).join('');
}
function renderPayHis() {
  const cs = dkey(curStart()), ks = [...new Set(Object.keys(PAY).map(k => k.slice(0, 10)))].filter(k => k < cs).sort().reverse();
  if (hSel && !ks.includes(hSel)) hSel = null;
  $('#h-rows').innerHTML = ks.length ? ks.map(k => {
    const s = new Date(k + 'T00:00'), rs = payRows(s, true), pend = rs.filter(r => r.st !== 'processed').length, t = f => num(rs.reduce((x, r) => x + r.c[f], 0));
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
  toast(rs.length ? `Payroll generated as draft for ${rs.length} employee${rs.length === 1 ? '' : 's'}.` : 'Payroll is already generated for this period.');
});
$('#p-adv').addEventListener('click', () => {
  const s = curStart(), A = autoDeds(s, weekEnd(s)); let n = 0; pSel.forEach(id => { if (payAdv(s, id, A)) n++; });
  savePay(); renderPayroll();
  toast(pSel.size ? `${n} payroll record${n === 1 ? '' : 's'} moved to the next step.` : 'Select employees first.', pSel.size ? 'ok' : 'err');
});
$('#h-rows').addEventListener('click', e => { const b = e.target.closest('[data-hp]'); if (b) { hSel = b.dataset.hp; hPage = 1; renderPayroll(); } });
$('#hd-back').addEventListener('click', () => { hSel = null; renderPayroll(); });
const pModal = $('#pay-modal');
function openPay(id, s, slip) {
  pOpen = { id, s, slip }; const e = EMP[id], c = payGet(id, s), st = pStatus(s, id);
  const line = (k, v, b) => `<div class="flex justify-between ${b ? 'font-semibold' : ''}"><dt class="${b ? '' : 'muted'}">${k}</dt><dd>${v}</dd></div>`;
  $('#pm-title').textContent = slip ? 'Payslip' : 'Payroll details';
  $('#pm-body').innerHTML = `<div><div class="font-medium">${esc(e.name)}</div><div class="muted">${id} · ${esc(e.pos)}</div><div class="muted text-xs mt-1">Pay period: ${fmR(s)} · <span class="badge ${PAY_ST[st][0]}">${PAY_ST[st][1]}</span></div></div>
  <div><h3 class="font-medium mb-2">Attendance summary</h3><dl class="space-y-1 border-t hair pt-2">${line('Scheduled days', c.days)}${line('Days present', c.present)}${line('Late', c.late)}${line('Absent', c.absent)}${line('Total hours', fmtHM(c.mins))}</dl></div>
  <div><h3 class="font-medium mb-2">Payroll</h3><dl class="space-y-1 border-t hair pt-2">${line('Basic rate', peso(c.rate) + '/hr')}${line('Regular pay (' + fmtHM(c.reg) + ')', peso(c.basic))}${c.ot ? line('Overtime (' + fmtHM(c.ot) + ' × 1.25)', peso(c.otPay)) : ''}${line('Gross pay', peso(c.gross))}${c.ds.map(x => line(`${DED_TYPES[x.type]} <span class="text-xs">(${fmtDate(x.date)})</span>`, '− ' + num(x.amount))).join('')}${line('Total deductions', peso(c.ded))}<div class="border-t hair pt-2">${line('NET PAY', peso(c.net), 1)}</div></dl></div>
  ${c.lates.length ? `<div><h3 class="font-medium mb-2">Late attendance</h3><ul class="space-y-2">${c.lates.map(l => `<li class="card p-3"><div>${l.d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${fmtMin(l.tin)}</div><div class="muted text-xs">Scheduled ${fmtMin(l.sin)} · Late by ${l.tin - l.sin} min</div></li>`).join('')}</ul></div>` : ''}`;
  const nx = PAY_NEXT[st], a = $('#pm-act'); a.classList.toggle('hidden', !nx || slip); if (nx) a.textContent = nx[1];
  pModal.classList.remove('hidden'); pModal.classList.add('flex');
}
const closePay = () => { pModal.classList.add('hidden'); pModal.classList.remove('flex'); };
$('#pm-x').addEventListener('click', closePay); $('#pm-close').addEventListener('click', closePay);
addEventListener('keydown', e => { if (e.key === 'Escape') closePay(); });
$('#pm-act').addEventListener('click', () => { payAdv(pOpen.s, pOpen.id); savePay(); toast(`${EMP[pOpen.id].name}: ${PAY_ST[pStatus(pOpen.s, pOpen.id)][1]}.`); closePay(); renderPayroll(); });
const payClick = (e, s) => {
  const b = e.target.closest('button'), c = e.target.closest('[data-sel]');
  if (c) { c.checked ? pSel.add(c.dataset.sel) : pSel.delete(c.dataset.sel); return; }
  if (b && b.dataset.pv) openPay(b.dataset.pv, s); else if (b && b.dataset.ps && !b.disabled) openPay(b.dataset.ps, s, true);
};
$('#p-rows').addEventListener('click', e => payClick(e, curStart()));
$('#hd-rows').addEventListener('click', e => payClick(e, new Date(hSel + 'T00:00')));

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
const SHELL = ['dashboard', 'employees', 'schedules', 'attendance', 'deductions', 'payroll'];
function route() {
  let v = location.hash.slice(2) || (sess ? 'home' : 'login');
  if (!['home', 'login', 'register', 'scan', 'verify', 'dashboard', 'employees', 'schedules', 'attendance', 'deductions', 'payroll', 'qr'].includes(v)) v = sess ? 'home' : 'login';
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
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.page === v));
    if (v === 'dashboard') renderDash(); else if (v === 'employees') renderEmployees(); else if (v === 'schedules') renderSchedule(); else if (v === 'deductions') renderDeductions(); else if (v === 'payroll') renderPayroll(); else renderAttendance();
    collapsed = !isDesk(); applySide();
  }
}
addEventListener('hashchange', route);
collapsed = !isDesk(); applySide();
route();
