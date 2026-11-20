/* Live arrivals for GMB routes 25 and 49M.
   Data: Transport Department eTA GMB API (data.etagmb.gov.hk).
   Route geometry and saved stops come from data.js. */

const API = 'https://data.etagmb.gov.hk';
const REFRESH_MS = 30000;
const MAX_ETAS = 3;
const MOVE_THRESHOLD_M = 20;

const state = {
  etas: new Map(),     // "routeId/seq/stopSeq" -> { list, enabled, desc, at }
  nearest: null,       // { route, stop, dist }
  lastUpdate: null,
  error: false,
  busy: false,
  lastPos: null,
};

const keyOf = (route, stop) => `${route.route_id}/${route.route_seq}/${stop.seq}`;

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function minutesFrom(entry, now) {
  const t = Date.parse(entry && entry.timestamp);
  if (Number.isFinite(t)) return Math.round((t - now) / 60000);
  if (entry && typeof entry.diff === 'number') return entry.diff;
  return null;
}

function sortedMinutes(list, now) {
  return list
    .map((entry) => minutesFrom(entry, now))
    .filter((m) => m !== null)
    .sort((a, b) => a - b);
}

function fmtTime(date) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtDistance(metres) {
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function distanceM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- data ---------------- */

async function fetchEta(route, stop) {
  const url = `${API}/eta/route-stop/${route.route_id}/${route.route_seq}/${stop.seq}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const data = body.data || {};
    state.etas.set(keyOf(route, stop), {
      enabled: data.enabled !== false,
      desc: data.description_en || '',
      list: Array.isArray(data.eta) ? data.eta : [],
      at: Date.now(),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(force = false) {
  if (state.busy) return;
  if (!force && state.lastUpdate && Date.now() - state.lastUpdate.getTime() < 5000) return;
  state.busy = true;
  setBusy(true);

  const jobs = new Map();
  for (const route of ROUTES) {
    for (const stop of route.bookmarks) {
      jobs.set(keyOf(route, stop), { route, stop });
    }
  }
  if (state.nearest) {
    const { route, stop } = state.nearest;
    jobs.set(keyOf(route, stop), { route, stop });
  }

  const results = await Promise.allSettled(
    [...jobs.values()].map(({ route, stop }) => fetchEta(route, stop)),
  );

  state.error = results.length > 0 && results.every((r) => r.status === 'rejected');
  state.lastUpdate = new Date();
  state.busy = false;
  setBusy(false);
  render();
}

/* ---------------- nearest stop ---------------- */

function computeNearest(pos) {
  let best = null;
  for (const route of ROUTES) {
    const seen = new Set();
    for (const stop of route.stops) {
      if (seen.has(stop.stop_id)) continue;
      seen.add(stop.stop_id);
      if (typeof stop.lat !== 'number' || typeof stop.lon !== 'number') continue;
      const dist = distanceM(pos, { lat: stop.lat, lon: stop.lon });
      if (!best || dist < best.dist) best = { route, stop, dist };
    }
  }
  return best;
}

async function updateNearest(pos) {
  const next = computeNearest(pos);
  if (!next) return;

  const changed = !state.nearest
    || keyOf(state.nearest.route, state.nearest.stop) !== keyOf(next.route, next.stop);

  state.nearest = next;

  if (changed) {
    const cached = state.etas.get(keyOf(next.route, next.stop));
    if (!cached || Date.now() - cached.at > REFRESH_MS - 5000) {
      try {
        await fetchEta(next.route, next.stop);
      } catch {
        /* keep showing the strip without a time */
      }
    }
  }
  render();
}

function startGeolocation() {
  if (!('geolocation' in navigator)) return;

  navigator.geolocation.watchPosition(
    (position) => {
      const pos = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      if (state.lastPos && distanceM(state.lastPos, pos) < MOVE_THRESHOLD_M) return;
      state.lastPos = pos;
      updateNearest(pos);
    },
    () => {
      if (state.nearest) {
        state.nearest = null;
        render();
      }
    },
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 },
  );
}

/* ---------------- rendering ---------------- */

function etasHtml(route, stop) {
  const cached = state.etas.get(keyOf(route, stop));

  if (!cached) return '<span class="empty">Loading…</span>';
  if (!cached.enabled) return `<span class="empty">${esc(cached.desc || 'Not available')}</span>`;

  const now = Date.now();
  const minutes = sortedMinutes(cached.list, now).slice(0, MAX_ETAS);
  if (!minutes.length) return '<span class="empty">No arrivals right now</span>';

  return minutes.map((m, i) => {
    const first = i === 0 ? ' first' : '';
    if (m <= 0) return `<span class="eta${first} due">Due</span>`;
    return `<span class="eta${first}"><b>${m}</b><small>min</small></span>`;
  }).join('');
}

function renderNearest() {
  const el = document.getElementById('nearest');
  if (!state.nearest) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  const { route, stop, dist } = state.nearest;
  const cached = state.etas.get(keyOf(route, stop));
  let eta = '…';

  if (cached) {
    if (!cached.enabled) {
      eta = '—';
    } else {
      const minutes = sortedMinutes(cached.list, Date.now());
      if (!minutes.length) eta = '—';
      else eta = minutes[0] <= 0 ? 'Due' : `${minutes[0]} min`;
    }
  }

  el.hidden = false;
  el.innerHTML = `
    <svg class="pin" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 21s-6.5-5.8-6.5-10.5a6.5 6.5 0 1 1 13 0C18.5 15.2 12 21 12 21z"/>
      <circle cx="12" cy="10.4" r="2.3"/>
    </svg>
    <div class="nearest-main">
      <div class="nearest-stop">${esc(route.code)} · ${esc(stop.name)}</div>
      <div class="nearest-dist">${fmtDistance(dist)} away</div>
    </div>
    <div class="nearest-eta">${esc(eta)}</div>`;
}

function renderStatus() {
  const dot = document.getElementById('dot');
  const label = document.getElementById('updated');

  if (state.error) {
    dot.className = 'dot err';
    label.textContent = 'Connection problem · retrying';
    return;
  }
  if (!state.lastUpdate) {
    dot.className = 'dot';
    label.textContent = 'Connecting…';
    return;
  }

  const age = (Date.now() - state.lastUpdate.getTime()) / 1000;
  dot.className = `dot ${age < REFRESH_MS + 45 ? 'live' : 'stale'}`;
  label.textContent = `Live · updated ${fmtTime(state.lastUpdate)}`;
}

function render() {
  let html = '';

  for (const route of ROUTES) {
    html += `
      <section class="route">
        <div class="route-head">
          <span class="badge">${esc(route.code)}</span>
          <span class="route-desc">${esc(route.orig)} → ${esc(route.dest)}</span>
        </div>`;

    for (const stop of route.bookmarks) {
      html += `
        <article class="card">
          <div class="card-top">
            <div class="stop-name">${esc(stop.name)}</div>
            <div class="stop-seq">Stop ${stop.seq}</div>
          </div>
          <div class="etas">${etasHtml(route, stop)}</div>
        </article>`;
    }

    html += '</section>';
  }

  document.getElementById('routes').innerHTML = html;
  renderNearest();
  renderStatus();
}

function setBusy(busy) {
  const button = document.getElementById('refresh');
  button.classList.toggle('spin', busy);
  button.disabled = busy;
}

/* ---------------- boot ---------------- */

function init() {
  render();
  document.getElementById('refresh').addEventListener('click', () => refresh(true));

  startGeolocation();
  refresh();

  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  window.addEventListener('online', () => refresh(true));

  const secure = location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1';

  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
