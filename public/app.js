const $app = document.getElementById('app');
const state = {
  me: null, kids: [], pools: [], pool: null, tab: 'rides', error: '', info: '',
  authMode: 'login', resetToken: null,
  notes: [], unread: 0, showNotes: false, editing: null, sharing: null,
  push: 'checking', // checking | unsupported | needs-install | unavailable | off | on | denied
};
let geoWatch = null, wakeLock = null, lastSent = 0, lastNoteId = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v) || 0;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const act = (fn) => async (...a) => { try { state.error = ''; state.info = ''; await fn(...a); } catch (e) { state.error = e.message; } render(); };

async function load() {
  try {
    const { user, ...rest } = await api('GET', '/api/me');
    Object.assign(state, rest, { me: user });
    if (state.pool || state.pools.length) {
      const id = state.pool?.id ?? state.pools[0].id;
      state.pool = state.pools.some((p) => p.id === id) ? await api('GET', `/api/pools/${id}`) : null;
    }
  } catch { state.me = null; stopSharing(); }
  render();
}

const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const today = () => new Date().toLocaleDateString('en-CA');
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

// ---------- notifications ----------
async function pollNotes(first = false) {
  if (!state.me) return;
  try {
    const { items, unread } = await api('GET', '/api/notifications');
    const fresh = items.filter((n) => n.id > lastNoteId && !n.read);
    lastNoteId = Math.max(lastNoteId, ...items.map((n) => n.id), 0);
    const changed = fresh.length > 0 || unread !== state.unread;
    state.notes = items; state.unread = unread;
    // refresh ride data when something happened or a ride is live, unless the user is typing
    const live = state.pool?.rides.some((r) => r.status === 'en_route');
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
    if (state.pool && (live || changed) && !typing) {
      state.pool = await api('GET', `/api/pools/${state.pool.id}`);
    }
    if (!typing) render();
  } catch { /* offline or logged out: try again next tick */ }
}
setInterval(() => { if (!document.hidden || state.sharing) pollNotes(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotes(); });

// ---------- Web Push ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
let swReg = null;

async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return isIOS && !standalone ? 'needs-install' : 'unsupported';
  try {
    swReg ??= await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'denied') return 'denied';
    const { key } = await api('GET', '/api/push/key');
    if (!key) return 'unavailable';
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch { return 'unsupported'; }
}
const subJson = (sub) => { const j = sub.toJSON(); return { endpoint: j.endpoint, keys: j.keys }; };

async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') { state.push = 'denied'; return; }
  const { key } = await api('GET', '/api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub;
  try { sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }); }
  catch { throw new Error("Couldn't reach your browser's push service. Check your connection and try again."); }
  await api('POST', '/api/push/subscribe', subJson(sub));
  state.push = 'on';
}
async function disablePush() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  state.push = 'off';
}
// A device that is already subscribed gets (re)attached to whoever is logged in now.
async function syncPush() {
  state.push = await pushStatus();
  if (state.push === 'on') {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api('POST', '/api/push/subscribe', subJson(sub)).catch(() => {});
  }
  render();
}
async function detachPush() { // on logout: stop sending this user's alerts to this device
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  } catch { /* best effort */ }
}

// ---------- location sharing (driver) ----------
async function startSharing(rideId) {
  if (!navigator.geolocation) throw new Error('This browser cannot share location');
  stopSharing();
  state.sharing = rideId;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  geoWatch = navigator.geolocation.watchPosition(
    (pos) => {
      if (Date.now() - lastSent < 8000) return;
      lastSent = Date.now();
      api('POST', `/api/rides/${rideId}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
    },
    (err) => { state.error = err.code === 1 ? 'Location permission denied – parents cannot see your position.' : 'Could not get your location.'; stopSharing(); render(); },
    { enableHighAccuracy: true, maximumAge: 5000 });
}
function stopSharing() {
  if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null; state.sharing = null;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}

// ---------- views ----------
function authView() {
  if (state.resetToken) return `<h1>🚗 Carpool</h1><div class="card"><h2>Choose a new password</h2><form id="resetForm">
      <label>New password (8+ chars)</label><input name="password" type="password" autocomplete="new-password" required>
      <div class="err">${esc(state.error)}</div><button class="primary">Save password</button></form></div>`;
  if (state.authMode === 'forgot') return `<h1>🚗 Carpool</h1><div class="card"><h2>Reset your password</h2><form id="forgotForm">
      <label>Email</label><input name="email" type="email" autocomplete="email" required>
      <div class="err">${esc(state.error)}</div><div class="muted">${esc(state.info)}</div>
      <div class="row"><button class="primary">Email me a link</button><button type="button" class="link" data-authmode="login">Back</button></div></form></div>`;
  return `<h1>🚗 Carpool</h1><p class="muted">Share school drop-offs and pickups with other parents.</p>
  <div class="card"><form id="auth">
    <div><label>Your name (new accounts)</label><input name="name" autocomplete="name"></div>
    <label>Email</label><input name="email" type="email" autocomplete="email" required>
    <label>Password (8+ chars)</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err">${esc(state.error)}</div><div class="muted">${esc(state.info)}</div>
    <div class="row"><button class="primary" data-mode="login">Log in</button><button data-mode="signup">Create account</button>
      <button type="button" class="link" data-authmode="forgot">Forgot password?</button></div>
  </form></div>`;
}

function trackBlock(r) {
  const loc = r.location;
  if (r.status !== 'en_route') return '';
  const lat = num(loc?.lat), lng = num(loc?.lng);
  const map = loc
    ? `<div class="muted">Driver location updated ${ago(loc.at)} · <a target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}">open map</a></div>
       <iframe class="map" loading="lazy" title="Driver location" src="https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.01}%2C${lat - 0.006}%2C${lng + 0.01}%2C${lat + 0.006}&layer=mapnik&marker=${lat}%2C${lng}"></iframe>`
    : (r.mine_driving ? '' : '<div class="muted">Waiting for the driver\'s location…</div>');
  return `<div style="margin-top:8px">${map}</div>`;
}

function rideCard(r) {
  const myKids = state.kids;
  const riding = new Set(r.riders.map((k) => k.id));
  const scheduled = r.status === 'scheduled';
  if (state.editing === r.id) return editCard(r);
  const statusTag = r.status === 'en_route' ? '<span class="tag live">On the way</span>' : r.status === 'completed' ? '<span class="tag done">Completed</span>'
    : r.driver_id ? `<span class="tag ok">Driver: ${esc(r.mine_driving ? 'you' : r.driver_name)}</span>` : '<span class="tag need">Needs a driver</span>';
  const buttons = [];
  if (scheduled && !r.driver_id) buttons.push(`<button class="small primary" data-drive="${r.id}">I'll drive</button>`);
  if (scheduled && r.mine_driving) {
    buttons.push(`<button class="small" data-undrive="${r.id}">Can't drive</button>`);
    if (r.date === today()) buttons.push(`<button class="small primary" data-start="${r.id}">Start ride</button>`);
  }
  if (r.status === 'en_route' && r.mine_driving) {
    buttons.push(state.sharing === r.id ? '<span class="tag live">Sharing location</span>' : `<button class="small" data-share="${r.id}">Share my location</button>`);
    buttons.push(`<button class="small primary" data-complete="${r.id}">Finish ride</button>`);
  }
  if (scheduled) for (const k of myKids)
    buttons.push(riding.has(k.id) ? `<button class="small" data-leave="${r.id}:${k.id}">Remove ${esc(k.name)}</button>`
      : r.seats_left > 0 ? `<button class="small" data-join="${r.id}:${k.id}">Add ${esc(k.name)}</button>` : '');
  if (scheduled && (r.created_by === state.me.id || r.mine_driving)) buttons.push(`<button class="small" data-edit="${r.id}">Edit</button>`);
  if (r.created_by === state.me.id) buttons.push(`<button class="small link" data-del="${r.id}">Delete</button>`);

  const kidLabel = { waiting: '', onboard: ' 🚗', done: ' ✅' };
  const kids = r.riders.length ? r.riders.map((k) => {
    const ctl = r.status === 'en_route' && r.mine_driving
      ? `<button class="small" data-kid="${r.id}:${k.id}:${k.state === 'waiting' ? 'onboard' : k.state === 'onboard' ? 'done' : 'waiting'}">${k.state === 'waiting' ? 'Picked up' : k.state === 'onboard' ? 'Arrived' : 'Undo'}</button>` : '';
    return `<span class="kid">${esc(k.name)}${kidLabel[k.state] ?? ''}${ctl}</span>`;
  }).join('') : 'none yet';
  return `<div class="card">
    <div class="row sb"><strong>${r.kind === 'dropoff' ? '🏫 Drop-off' : '🏠 Pickup'} · ${fmtDate(r.date)} ${esc(r.time)}</strong>${statusTag}</div>
    <div>📍 ${esc(r.place)}${r.dest ? ` <strong>→</strong> 🏁 ${esc(r.dest)}` : ''}</div>
    <div class="muted">${r.seats_left}/${r.seats} seats open</div>
    <div class="muted">Kids: ${kids}</div>${trackBlock(r)}
    <div class="row" style="margin-top:8px">${buttons.join('')}</div></div>`;
}

function editCard(r) {
  const members = state.pool.members.map((m) => `<option value="${m.id}" ${m.id === r.driver_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  return `<form class="card" data-editform="${r.id}"><strong>Edit ride</strong>
    <div class="grid2"><div><label>Date</label><input name="date" type="date" value="${esc(r.date)}" required></div>
    <div><label>Time</label><input name="time" type="time" value="${esc(r.time)}" required></div>
    <div><label>Seats</label><input name="seats" type="number" min="${Math.max(1, r.riders.length)}" max="12" value="${num(r.seats)}"></div>
    <div><label>Driver</label><select name="driver_id"><option value="">Needs a driver</option>${members}</select></div></div>
    <label>Pick up from</label><input name="place" value="${esc(r.place)}" required>
    <label>Drop off at</label><input name="dest" value="${esc(r.dest)}">
    <div class="row" style="margin-top:8px"><button class="primary">Save</button><button type="button" data-canceledit>Cancel</button></div></form>`;
}

function poolView() {
  const p = state.pool;
  const unclaimed = p.rides.filter((r) => !r.driver_id && r.status === 'scheduled').length;
  const tabs = ['rides', 'new', 'people'].map((t) => `<button data-tab="${t}" class="${state.tab === t ? 'active' : ''}">${{ rides: 'Rides', new: '+ Add ride', people: 'People' }[t]}</button>`).join('');
  let body = '';
  if (state.tab === 'rides') {
    body = (unclaimed ? `<div class="banner">${unclaimed} ride${unclaimed > 1 ? 's' : ''} still need a driver.</div>` : '') +
      (p.rides.map(rideCard).join('') || '<p class="muted">No upcoming rides yet. Add one!</p>');
  } else if (state.tab === 'new') {
    body = `<form id="newRide" class="card">
      <div class="grid2"><div><label>Type</label><select name="kind"><option value="dropoff">Drop-off run (taking kids to school/activity)</option><option value="pickup">Pickup run (bringing kids home)</option></select></div>
      <div><label>Seats for kids</label><input name="seats" type="number" min="1" max="12" value="4"></div>
      <div><label>Date</label><input name="date" type="date" value="${today()}" required></div>
      <div><label>Time</label><input name="time" type="time" value="08:00" required></div></div>
      <label>Pick up from (address or meeting spot)</label><input name="place" placeholder="e.g. 12 Oak St, or the corner of Elm &amp; 5th" required>
      <label>Drop off at</label><input name="dest" placeholder="e.g. Maple Elementary, 40 School Rd" required>
      <label>Repeat weekly for (weeks)</label><input name="repeat_weeks" type="number" min="1" max="26" value="1">
      <label class="row"><input type="checkbox" name="drive" style="width:auto"> I'll drive this one</label>
      <div class="err">${esc(state.error)}</div><button class="primary">Add ride</button></form>`;
  } else {
    body = `<div class="card"><div class="muted">Invite other parents with this code</div><h2 style="margin:.2em 0">${esc(p.code)}</h2></div>
      <h2>Parents (drives taken)</h2>` +
      p.members.map((m) => `<div class="card row sb"><span>${esc(m.name)}${m.phone ? ` · <a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ''}</span><span class="tag">${num(m.drives)} drives</span></div>`).join('') +
      `<h2>Kids</h2><div class="card">${p.kids.map((k) => esc(k.name)).join(', ') || 'None yet'}</div>
       <button class="small" data-leavepool>Leave this pool</button>`;
  }
  return `<div class="row sb"><h1>${esc(p.name)}</h1><div class="row">${bell()}<button class="small" data-switch>Switch pool</button></div></div>${notesPanel()}<nav>${tabs}</nav><div class="err">${state.tab === 'new' ? '' : esc(state.error)}</div>${body}`;
}

const bell = () => `<button class="small bell" data-bell aria-label="Notifications">🔔${state.unread ? `<span class="n">${num(state.unread)}</span>` : ''}</button>`;

function notesPanel() {
  if (!state.showNotes) return '';
  const perm = {
    off: '<button class="small primary" data-pushon>Turn on push alerts</button>',
    on: '<span class="tag ok">Push alerts on</span> <button class="small link" data-pushoff>turn off</button>',
    denied: '<span class="muted">Alerts are blocked in this browser\'s settings</span>',
    'needs-install': '<span class="muted">On iPhone: tap Share → Add to Home Screen, then open Carpool from there to enable alerts</span>',
    unsupported: '<span class="muted">This browser can\'t do push alerts</span>',
    unavailable: '<span class="muted">Push alerts aren\'t enabled on this server</span>',
  }[state.push] ?? '';
  const email = `<label class="row" style="margin:4px 0"><input type="checkbox" data-emailpref style="width:auto" ${state.me.email_notifs ? 'checked' : ''}> Also email me</label>`;
  return `<div class="card"><strong>Notifications</strong><div class="row" style="margin:6px 0">${perm}</div>${email}
    ${state.notes.map((n) => `<div class="note ${n.read ? '' : 'new'}">${esc(n.text)}<div class="muted">${new Date(n.created_at).toLocaleString()}</div></div>`).join('') || '<div class="muted">Nothing yet.</div>'}</div>`;
}

function homeView() {
  const kidList = state.kids.map((k) => `<span class="tag">${esc(k.name)} <button class="link" data-rmkid="${k.id}">×</button></span>`).join(' ');
  return `<div class="row sb"><h1>Hi ${esc(state.me.name)}</h1><div class="row">${bell()}<button class="small" data-logout>Log out</button></div></div>${notesPanel()}
    <h2>Your children</h2><div class="card">${kidList || '<span class="muted">Add your kids so you can book them on rides.</span>'}
      <form id="addKid" class="row" style="margin-top:8px"><input name="name" placeholder="Child's name" style="flex:1"><button>Add</button></form></div>
    <h2>Your pools</h2>${state.pools.map((p) => `<div class="card row sb"><strong>${esc(p.name)}</strong><button class="small primary" data-open="${p.id}">Open</button></div>`).join('') || '<p class="muted">Create a pool (e.g. “Room 4 – Maple Elementary”) or join with a code.</p>'}
    <div class="grid2"><form id="newPool" class="card"><label>New pool name</label><input name="name" required><button class="primary" style="margin-top:8px">Create</button></form>
    <form id="joinPool" class="card"><label>Invite code</label><input name="code" required><button style="margin-top:8px">Join</button></form></div>
    <div class="err">${esc(state.error)}</div>`;
}

function render() {
  if (!state.me) { $app.innerHTML = authView(); return bindAuth(); }
  $app.innerHTML = state.pool ? poolView() : homeView();
  bind();
}

// ---------- events ----------
const on = (sel, ev, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
const formData = (e) => { e.preventDefault(); return Object.fromEntries(new FormData(e.target)); };
const ids = (v) => v.split(':').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
const refresh = async () => { await load(); pollNotes(true); syncPush(); };

function bindAuth() {
  const form = document.getElementById('auth');
  form?.querySelectorAll('button[data-mode]').forEach((b) => b.addEventListener('click', act(async (e) => {
    e.preventDefault();
    await api('POST', b.dataset.mode === 'signup' ? '/api/signup' : '/api/login', Object.fromEntries(new FormData(form)));
    await refresh();
  })));
  on('[data-authmode]', 'click', (e) => { state.authMode = e.target.dataset.authmode; state.error = state.info = ''; render(); });
  on('#forgotForm', 'submit', act(async (e) => {
    await api('POST', '/api/password/forgot', formData(e));
    state.info = 'If that email has an account, a reset link is on its way.';
  }));
  on('#resetForm', 'submit', act(async (e) => {
    await api('POST', '/api/password/reset', { ...formData(e), token: state.resetToken });
    state.resetToken = null; history.replaceState(null, '', location.pathname);
    await refresh();
  }));
}

function bind() {
  on('[data-logout]', 'click', act(async () => { stopSharing(); await detachPush(); await api('POST', '/api/logout'); state.me = null; state.pool = null; state.showNotes = false; }));
  on('[data-bell]', 'click', act(async () => {
    state.showNotes = !state.showNotes;
    if (state.showNotes) { await pollNotes(true); if (state.unread) { await api('POST', '/api/notifications/read'); state.unread = 0; } }
  }));
  on('[data-pushon]', 'click', act(enablePush));
  on('[data-pushoff]', 'click', act(disablePush));
  on('[data-emailpref]', 'change', act(async (e) => { const r = await api('PATCH', '/api/me', { email_notifs: e.target.checked }); state.me = r.user; }));
  on('#addKid', 'submit', act(async (e) => { await api('POST', '/api/kids', formData(e)); await load(); }));
  on('[data-rmkid]', 'click', act(async (e) => { await api('DELETE', `/api/kids/${e.target.dataset.rmkid}`); await load(); }));
  on('#newPool', 'submit', act(async (e) => {
    const r = await api('POST', '/api/pools', { ...formData(e), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    state.pool = { id: r.id }; await load();
  }));
  on('#joinPool', 'submit', act(async (e) => { const r = await api('POST', '/api/pools/join', formData(e)); state.pool = { id: r.id }; await load(); }));
  on('[data-open]', 'click', act(async (e) => { state.pool = { id: Number(e.target.dataset.open) }; state.tab = 'rides'; await load(); }));
  on('[data-switch]', 'click', () => { state.pool = null; render(); });
  on('[data-tab]', 'click', (e) => { state.tab = e.target.dataset.tab; state.error = ''; render(); });
  on('#newRide', 'submit', act(async (e) => {
    const f = formData(e); f.drive = e.target.drive.checked;
    await api('POST', `/api/pools/${state.pool.id}/rides`, f);
    state.tab = 'rides'; await load();
  }));
  const post = (attr, path, method = 'POST') => on(`[data-${attr}]`, 'click', act(async (e) => { await api(method, path(e.target.dataset[attr])); await load(); }));
  post('drive', (id) => `/api/rides/${id}/drive`);
  post('undrive', (id) => `/api/rides/${id}/drive`, 'DELETE');
  post('complete', (id) => `/api/rides/${id}/complete`);
  on('[data-complete]', 'click', () => stopSharing());
  on('[data-start]', 'click', act(async (e) => {
    const id = Number(e.target.dataset.start);
    await api('POST', `/api/rides/${id}/start`); await load();
    try { await startSharing(id); } catch (err) { state.error = err.message; }
  }));
  on('[data-share]', 'click', act(async (e) => { await startSharing(Number(e.target.dataset.share)); }));
  on('[data-join]', 'click', act(async (e) => { const [r, k] = ids(e.target.dataset.join); await api('POST', `/api/rides/${r}/riders`, { kid_id: k }); await load(); }));
  on('[data-leave]', 'click', act(async (e) => { const [r, k] = ids(e.target.dataset.leave); await api('DELETE', `/api/rides/${r}/riders/${k}`); await load(); }));
  on('[data-kid]', 'click', act(async (e) => { const [r, k, s] = ids(e.target.dataset.kid); await api('POST', `/api/rides/${r}/riders/${k}/state`, { state: s }); await load(); }));
  on('[data-del]', 'click', act(async (e) => { if (confirm('Delete this ride?')) { await api('DELETE', `/api/rides/${e.target.dataset.del}`); await load(); } }));
  on('[data-edit]', 'click', (e) => { state.editing = Number(e.target.dataset.edit); render(); });
  on('[data-canceledit]', 'click', () => { state.editing = null; render(); });
  on('[data-editform]', 'submit', act(async (e) => {
    const f = formData(e), id = Number(e.target.dataset.editform);
    await api('PATCH', `/api/rides/${id}`, { date: f.date, time: f.time, place: f.place, dest: f.dest, seats: Number(f.seats), driver_id: f.driver_id ? Number(f.driver_id) : null });
    state.editing = null; await load();
  }));
  on('[data-leavepool]', 'click', act(async () => { if (confirm('Leave this pool?')) { await api('DELETE', `/api/pools/${state.pool.id}/membership`); state.pool = null; await load(); } }));
}

const m = /^#reset=([a-f0-9]+)$/.exec(location.hash);
if (m) { state.resetToken = m[1]; history.replaceState(null, '', location.pathname); }
load().then(() => { pollNotes(true); if (state.me) syncPush(); });
