const $app = document.getElementById('app');
const state = { me: null, kids: [], pools: [], pool: null, tab: 'rides', error: '' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const act = (fn) => async (...a) => { try { state.error = ''; await fn(...a); } catch (e) { state.error = e.message; } render(); };

async function load() {
  try {
    const me = await api('GET', '/api/me');
    Object.assign(state, me);
    if (state.pool || state.pools.length) {
      const id = state.pool?.id ?? state.pools[0].id;
      state.pool = state.pools.some((p) => p.id === id) ? await api('GET', `/api/pools/${id}`) : null;
    }
  } catch { state.me = null; }
  render();
}
const reloadPool = async () => { await load(); };

const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const today = () => new Date().toISOString().slice(0, 10);

function authView() {
  return `<h1>🚗 Carpool</h1><p class="muted">Share school drop-offs and pickups with other parents.</p>
  <div class="card"><form id="auth">
    <div id="signupFields"><label>Your name</label><input name="name" autocomplete="name"></div>
    <label>Email</label><input name="email" type="email" autocomplete="email" required>
    <label>Password (8+ chars)</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err">${esc(state.error)}</div>
    <div class="row"><button class="primary" data-mode="login">Log in</button><button data-mode="signup">Create account</button></div>
  </form></div>`;
}

function rideCard(r) {
  const myKids = state.kids;
  const riding = new Set(r.riders.map((k) => k.id));
  const driverTag = r.driver_id
    ? `<span class="tag ok">Driver: ${esc(r.mine_driving ? 'you' : r.driver_name)}</span>`
    : `<span class="tag need">Needs a driver</span>`;
  const buttons = [];
  if (!r.driver_id) buttons.push(`<button class="small primary" data-drive="${r.id}">I'll drive</button>`);
  if (r.mine_driving) buttons.push(`<button class="small" data-undrive="${r.id}">Can't drive</button>`);
  for (const k of myKids) {
    buttons.push(riding.has(k.id)
      ? `<button class="small" data-leave="${r.id}:${k.id}">Remove ${esc(k.name)}</button>`
      : r.seats_left > 0 ? `<button class="small" data-join="${r.id}:${k.id}">Add ${esc(k.name)}</button>` : '');
  }
  if (r.created_by === state.me.id) buttons.push(`<button class="small link" data-del="${r.id}">Delete</button>`);
  return `<div class="card">
    <div class="row sb"><strong>${r.kind === 'dropoff' ? '🏫 Drop-off' : '🏠 Pickup'} · ${fmtDate(r.date)} ${esc(r.time)}</strong>${driverTag}</div>
    <div class="muted">${esc(r.place)} · ${r.seats_left}/${r.seats} seats open</div>
    <div class="muted">Kids: ${r.riders.length ? r.riders.map((k) => esc(k.name)).join(', ') : 'none yet'}</div>
    <div class="row" style="margin-top:8px">${buttons.join('')}</div></div>`;
}

function poolView() {
  const p = state.pool;
  const unclaimed = p.rides.filter((r) => !r.driver_id).length;
  const tabs = ['rides', 'new', 'people'].map((t) => `<button data-tab="${t}" class="${state.tab === t ? 'active' : ''}">${{ rides: 'Rides', new: '+ Add ride', people: 'People' }[t]}</button>`).join('');
  let body = '';
  if (state.tab === 'rides') {
    body = (unclaimed ? `<div class="muted">${unclaimed} ride${unclaimed > 1 ? 's' : ''} still need a driver.</div>` : '') +
      (p.rides.map(rideCard).join('') || '<p class="muted">No upcoming rides yet. Add one!</p>');
  } else if (state.tab === 'new') {
    body = `<form id="newRide" class="card">
      <div class="grid2"><div><label>Type</label><select name="kind"><option value="dropoff">Drop-off</option><option value="pickup">Pickup</option></select></div>
      <div><label>Seats for kids</label><input name="seats" type="number" min="1" max="12" value="4"></div>
      <div><label>Date</label><input name="date" type="date" value="${today()}" required></div>
      <div><label>Time</label><input name="time" type="time" value="08:00" required></div></div>
      <label>Where (school / address)</label><input name="place" required>
      <label>Repeat weekly for (weeks)</label><input name="repeat_weeks" type="number" min="1" max="26" value="1">
      <label class="row"><input type="checkbox" name="drive" style="width:auto"> I'll drive this one</label>
      <div class="err">${esc(state.error)}</div><button class="primary">Add ride</button></form>`;
  } else {
    body = `<div class="card"><div class="muted">Invite other parents with this code</div><h2 style="margin:.2em 0">${esc(p.code)}</h2></div>
      <h2>Parents (drives taken)</h2>` +
      p.members.map((m) => `<div class="card row sb"><span>${esc(m.name)}${m.phone ? ` · <a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ''}</span><span class="tag">${m.drives} drives</span></div>`).join('') +
      `<h2>Kids</h2><div class="card">${p.kids.map((k) => esc(k.name)).join(', ') || 'None yet'}</div>
       <button class="small" data-leavepool>Leave this pool</button>`;
  }
  return `<div class="row sb"><h1>${esc(p.name)}</h1><button class="small" data-switch>Switch pool</button></div><nav>${tabs}</nav>${body}`;
}

function homeView() {
  const kidList = state.kids.map((k) => `<span class="tag">${esc(k.name)} <button class="link" data-rmkid="${k.id}">×</button></span>`).join(' ');
  return `<div class="row sb"><h1>Hi ${esc(state.me.name)}</h1><button class="small" data-logout>Log out</button></div>
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

function bindAuth() {
  const form = document.getElementById('auth');
  form.querySelectorAll('button').forEach((b) => b.addEventListener('click', act(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const signup = b.dataset.mode === 'signup';
    await api('POST', signup ? '/api/signup' : '/api/login', f);
    await load();
  })));
}

const on = (sel, ev, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
const formData = (e) => { e.preventDefault(); return Object.fromEntries(new FormData(e.target)); };
const pair = (v) => v.split(':').map(Number);

function bind() {
  on('[data-logout]', 'click', act(async () => { await api('POST', '/api/logout'); state.me = null; state.pool = null; }));
  on('#addKid', 'submit', act(async (e) => { await api('POST', '/api/kids', formData(e)); await load(); }));
  on('[data-rmkid]', 'click', act(async (e) => { await api('DELETE', `/api/kids/${e.target.dataset.rmkid}`); await load(); }));
  on('#newPool', 'submit', act(async (e) => { const r = await api('POST', '/api/pools', formData(e)); state.pool = { id: r.id }; await load(); }));
  on('#joinPool', 'submit', act(async (e) => { const r = await api('POST', '/api/pools/join', formData(e)); state.pool = { id: r.id }; await load(); }));
  on('[data-open]', 'click', act(async (e) => { state.pool = { id: Number(e.target.dataset.open) }; state.tab = 'rides'; await load(); }));
  on('[data-switch]', 'click', () => { state.pool = null; render(); });
  on('[data-tab]', 'click', (e) => { state.tab = e.target.dataset.tab; state.error = ''; render(); });
  on('#newRide', 'submit', act(async (e) => {
    const f = formData(e);
    f.drive = e.target.drive.checked;
    await api('POST', `/api/pools/${state.pool.id}/rides`, f);
    state.tab = 'rides'; await reloadPool();
  }));
  on('[data-drive]', 'click', act(async (e) => { await api('POST', `/api/rides/${e.target.dataset.drive}/drive`); await reloadPool(); }));
  on('[data-undrive]', 'click', act(async (e) => { await api('DELETE', `/api/rides/${e.target.dataset.undrive}/drive`); await reloadPool(); }));
  on('[data-join]', 'click', act(async (e) => { const [r, k] = pair(e.target.dataset.join); await api('POST', `/api/rides/${r}/riders`, { kid_id: k }); await reloadPool(); }));
  on('[data-leave]', 'click', act(async (e) => { const [r, k] = pair(e.target.dataset.leave); await api('DELETE', `/api/rides/${r}/riders/${k}`); await reloadPool(); }));
  on('[data-del]', 'click', act(async (e) => { if (confirm('Delete this ride?')) { await api('DELETE', `/api/rides/${e.target.dataset.del}`); await reloadPool(); } }));
  on('[data-leavepool]', 'click', act(async () => { if (confirm('Leave this pool?')) { await api('DELETE', `/api/pools/${state.pool.id}/membership`); state.pool = null; await load(); } }));
}

load();
