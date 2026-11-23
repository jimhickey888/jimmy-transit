/* Jimmy Transit push worker.
 *
 * Stores a Web Push subscription plus one scheduled alert per tracked bus,
 * and a cron trigger checks every minute and sends the notification.
 *
 * Deploy with wrangler (see README.md) or paste this file into the
 * Cloudflare dashboard. Required configuration:
 *   KV binding   ALERTS
 *   Secret       VAPID_PRIVATE_JWK   (EC P-256 private key as a JWK)
 *   Variable     VAPID_PUBLIC_KEY    (uncompressed P-256 point, base64url)
 *   Variable     VAPID_SUBJECT       (mailto:you@example.com or https URL)
 *   Cron         * * * * *
 */

const ALLOWED_ORIGINS = [
  'https://jimhickey888.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const MAX_LEAD_MIN = 30;
const MAX_ALERT_BATCH = 12;

/* A pointer to the next time anything is due. The cron reads this one key per
   minute and only scans (KV list) when the pointer says something is due.
   Without it, a once-a-minute list would use 1,440 list ops/day against the
   free tier's 1,000. */
const NEXT_KEY = 'meta:next';
const IDLE_NEXT_MS = 60 * 60 * 1000; // re-check hourly when nothing is queued
const utf8 = new TextEncoder();

/* ---------------- encoding helpers ---------------- */

export function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/* ---------------- RFC 8291 payload encryption ---------------- */

export async function encryptPayload(subscription, payload) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey },
    ephemeral.privateKey,
    256,
  ));

  const context = concat(utf8.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, context, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(utf8.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    aesKey,
    plaintext,
  ));

  const recordSize = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const header = concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/* ---------------- RFC 8292 VAPID ---------------- */

export async function vapidHeaders(endpoint, privateJwk, publicKey, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const signingInput = `${b64urlEncode(utf8.encode(JSON.stringify(header)))}.`
    + b64urlEncode(utf8.encode(JSON.stringify(claims)));

  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8.encode(signingInput),
  ));

  return {
    Authorization: `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${publicKey}`,
  };
}

export async function sendPush(subscription, payload, vapid) {
  const body = await encryptPayload(subscription, payload);
  const headers = {
    ...(await vapidHeaders(subscription.endpoint, vapid.privateJwk, vapid.publicKey, vapid.subject)),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: '300',
    Urgency: 'high',
  };
  const response = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  return { ok: response.ok, status: response.status };
}

function vapidConfig(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID_PRIVATE_JWK, VAPID_PUBLIC_KEY and VAPID_SUBJECT are required');
  }
  return {
    privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK),
    publicKey: env.VAPID_PUBLIC_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

/* ---------------- HTTP helpers ---------------- */

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function subIdFor(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(endpoint));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validAlert(alert) {
  return alert
    && typeof alert.id === 'string'
    && alert.id.length >= 6
    && alert.id.length <= 80
    && Number.isFinite(Number(alert.fireAt));
}

function validSubscription(subscription) {
  return subscription
    && typeof subscription.endpoint === 'string'
    && subscription.endpoint.startsWith('https://')
    && subscription.keys
    && typeof subscription.keys.p256dh === 'string'
    && typeof subscription.keys.auth === 'string';
}

async function storeSubscription(env, subscription) {
  const endpoint = subscription.endpoint;
  const keys = { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth };
  const subId = await subIdFor(endpoint);

  await env.ALERTS.put(
    `sub:${subId}`,
    JSON.stringify({ endpoint, keys }),
    { expirationTtl: 60 * 60 * 24 * 120 },
  );
  return subId;
}

async function storeOneAlert(env, subId, alert) {
  const now = Date.now();
  const fireAt = Math.max(now + 15000, Math.min(Number(alert.fireAt), now + 24 * 60 * 60 * 1000));
  const leadMinutes = Math.min(MAX_LEAD_MIN, Math.max(0, Number(alert.leadMinutes) || 5));
  const record = {
    subId,
    fireAt,
    leadMinutes,
    title: String(alert.title || 'Bus arriving soon').slice(0, 80),
    body: String(alert.body || '').slice(0, 160),
    tag: String(alert.tag || `bus-${alert.id}`).slice(0, 80),
    createdAt: now,
    attempts: 0,
  };

  const ttl = Math.max(3600, Math.ceil((fireAt - now) / 1000) + 86400);
  await env.ALERTS.put(`alert:${alert.id}`, JSON.stringify(record), { expirationTtl: ttl });
  return fireAt;
}

async function storeAlert(env, subscription, alert) {
  const subId = await storeSubscription(env, subscription);
  const fireAt = await storeOneAlert(env, subId, alert);
  return { subId, fireAt };
}

/* ---------------- scheduling pointer ---------------- */

async function nextAlarm(env) {
  try {
    return await env.ALERTS.get(NEXT_KEY, 'json');
  } catch {
    return null;
  }
}

async function setNextAlarm(env, at) {
  const target = Number.isFinite(at) ? at : Date.now() + IDLE_NEXT_MS;
  try {
    await env.ALERTS.put(NEXT_KEY, JSON.stringify({ at: target }), {
      expirationTtl: 60 * 60 * 48,
    });
  } catch {
    /* the cron will fall back to a scan */
  }
}

/* Move the pointer earlier when a new alert is scheduled. A lost race can only
   delay the earlier alert until the idle re-check (one hour), never longer. */
async function noteNext(env, fireAt) {
  const current = await nextAlarm(env);
  if (!current || Number(fireAt) < Number(current.at)) {
    await setNextAlarm(env, Number(fireAt));
  }
}

/* ---------------- cron ---------------- */

async function retryOrDrop(env, keyName, record) {
  record.attempts = (record.attempts || 0) + 1;
  if (record.attempts >= 5) {
    await env.ALERTS.delete(keyName);
  } else {
    await env.ALERTS.put(keyName, JSON.stringify(record), { expirationTtl: 3600 });
  }
}

export async function sendDueAlerts(env) {
  const now = Date.now();
  const next = await nextAlarm(env);
  if (next && Number(next.at) > now) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const vapid = vapidConfig(env);
  let sent = 0;
  let failed = 0;
  let earliest = Infinity;
  let cursor;

  do {
    const listed = await env.ALERTS.list({ prefix: 'alert:', cursor });
    for (const key of listed.keys) {
      const record = await env.ALERTS.get(key.name, 'json');
      if (!record) continue;
      if (record.fireAt > now) {
        earliest = Math.min(earliest, record.fireAt);
        continue;
      }

      if (now - record.fireAt > 15 * 60 * 1000) {
        await env.ALERTS.delete(key.name);
        continue;
      }

      /* One malformed subscription must not block every other alert. */
      try {
        const subscription = await env.ALERTS.get(`sub:${record.subId}`, 'json');
        if (!subscription) {
          await env.ALERTS.delete(key.name);
          continue;
        }

        const result = await sendPush(subscription, {
          title: record.title,
          body: record.body,
          tag: record.tag,
          url: './',
        }, vapid);

        if (result.ok) {
          sent += 1;
          await env.ALERTS.delete(key.name);
        } else if (result.status === 404 || result.status === 410) {
          failed += 1;
          await env.ALERTS.delete(`sub:${record.subId}`);
          await env.ALERTS.delete(key.name);
        } else {
          failed += 1;
          earliest = Math.min(earliest, record.fireAt);
          await retryOrDrop(env, key.name, record);
        }
      } catch (error) {
        console.error('alert failed', key.name, error);
        failed += 1;
        earliest = Math.min(earliest, record.fireAt);
        await retryOrDrop(env, key.name, record);
      }
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);

  await setNextAlarm(env, earliest === Infinity ? now + IDLE_NEXT_MS : earliest);

  return { sent, failed };
}

/* ---------------- durable object scheduler ---------------- */

/* Optional: one instance schedules an alarm at the next due time, so alerts
   go out within seconds without the cron polling KV. Without the SCHEDULER
   binding the worker falls back to the cron scan. */
export class AlertScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async alerts() {
    return (await this.state.storage.get('alerts')) || [];
  }

  async subs() {
    return (await this.state.storage.get('subs')) || {};
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/alerts' && request.method === 'POST') {
        return await this.schedule(await request.json());
      }
      if (url.pathname === '/alert' && request.method === 'DELETE') {
        return await this.cancel(url.searchParams.get('id'));
      }
      if (url.pathname === '/alerts' && request.method === 'GET') {
        const list = await this.alerts();
        return this.json({ count: list.length });
      }
      if (url.pathname === '/run' && request.method === 'POST') {
        return this.json(await this.runDue());
      }
      if (url.pathname === '/watchdog' && request.method === 'POST') {
        const alarm = await this.state.storage.getAlarm();
        if (!alarm || alarm <= Date.now() - 2 * 60 * 1000) {
          return this.json(await this.runDue());
        }
        await this.arm(await this.alerts());
        return this.json({ ok: true, skipped: true });
      }
      if (url.pathname === '/tick' && request.method === 'POST') {
        await this.arm(await this.alerts());
        return this.json({ ok: true });
      }
      if (url.pathname === '/status') {
        const list = await this.alerts();
        return this.json({ count: list.length, alarm: await this.state.storage.getAlarm() });
      }
    } catch (error) {
      console.error('scheduler fetch failed', error);
      return this.json({ error: String(error && error.message ? error.message : error) }, 500);
    }
    return this.json({ error: 'not found' }, 404);
  }

  async schedule(body) {
    const subId = String(body.subId || '');
    const subscription = body.subscription;
    const incoming = Array.isArray(body.alerts) ? body.alerts : [];
    if (!subId || !subscription || !incoming.length) {
      return this.json({ error: 'subId, subscription and alerts are required' }, 400);
    }

    const subs = await this.subs();
    subs[subId] = subscription;

    const now = Date.now();
    let list = await this.alerts();
    const fireAt = [];

    for (const alert of incoming) {
      const at = Math.max(now + 15000, Math.min(Number(alert.fireAt), now + 24 * 60 * 60 * 1000));
      fireAt.push(at);
      const record = {
        id: String(alert.id),
        subId,
        fireAt: at,
        title: String(alert.title || 'Bus arriving soon').slice(0, 80),
        body: String(alert.body || '').slice(0, 160),
        tag: String(alert.tag || `bus-${alert.id}`).slice(0, 80),
        createdAt: now,
        attempts: 0,
      };
      list = list.filter((item) => item.id !== record.id);
      list.push(record);
    }

    await this.state.storage.put('subs', subs);
    await this.state.storage.put('alerts', list);
    await this.arm(list);
    return this.json({ ok: true, subId, alerts: incoming.length, fireAt });
  }

  async cancel(id) {
    if (!id) return this.json({ error: 'id is required' }, 400);
    const list = (await this.alerts()).filter((item) => item.id !== id);
    await this.state.storage.put('alerts', list);
    await this.arm(list);
    return this.json({ ok: true });
  }

  async arm(list) {
    const now = Date.now();
    const next = list.reduce(
      (min, item) => Math.min(min, Number(item.fireAt) || Infinity),
      Infinity,
    );
    const at = Number.isFinite(next)
      ? Math.max(next, now + 500)
      : now + 24 * 60 * 60 * 1000;
    const current = await this.state.storage.getAlarm();
    if (!current || Math.abs(current - at) > 500) {
      await this.state.storage.setAlarm(at);
    }
  }

  async runDue() {
    const now = Date.now();
    const vapid = vapidConfig(this.env);
    const subs = await this.subs();
    const list = await this.alerts();
    const remaining = [];
    let sent = 0;
    let failed = 0;

    for (const record of list) {
      if (record.fireAt > now) {
        remaining.push(record);
        continue;
      }
      if (now - record.fireAt > 15 * 60 * 1000) continue;

      const subscription = subs[record.subId];
      if (!subscription) continue;

      try {
        const result = await sendPush(subscription, {
          title: record.title,
          body: record.body,
          tag: record.tag,
          url: './',
        }, vapid);

        if (result.ok) {
          sent += 1;
          continue;
        }
        if (result.status === 404 || result.status === 410) {
          delete subs[record.subId];
          continue;
        }
      } catch (error) {
        console.error('alert failed', record.id, error);
      }

      record.attempts = (record.attempts || 0) + 1;
      failed += 1;
      if (record.attempts < 5) {
        record.fireAt = now + 60 * 1000;
        remaining.push(record);
      }
    }

    await this.state.storage.put('subs', subs);
    await this.state.storage.put('alerts', remaining);
    await this.arm(remaining);
    return { sent, failed };
  }

  async alarm() {
    try {
      await this.runDue();
    } catch (error) {
      console.error('scheduler alarm failed', error);
      await this.state.storage.setAlarm(Date.now() + 60 * 1000);
    }
  }
}

function schedulerStub(env) {
  if (!env.SCHEDULER) return null;
  return env.SCHEDULER.get(env.SCHEDULER.idFromName('global'));
}

async function relayScheduler(response, origin) {
  const data = await response.json().catch(() => ({ error: 'scheduler error' }));
  return json(data, response.status, origin);
}

/* ---------------- worker ---------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const headers = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'jimmy-transit-push', scheduler: env.SCHEDULER ? 'durable-object' : 'next-pointer', now: Date.now() }, 200, origin);
    }

    if (url.pathname === '/alert' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400, origin);
      }

      if (!validSubscription(body.subscription)) {
        return json({ error: 'subscription must include endpoint, keys.p256dh, keys.auth' }, 400, origin);
      }
      if (!validAlert(body.alert)) {
        return json({ error: 'alert.id and alert.fireAt are required' }, 400, origin);
      }

      if (env.SCHEDULER) {
        const subId = await subIdFor(body.subscription.endpoint);
        const response = await schedulerStub(env).fetch('https://scheduler/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subId,
            subscription: body.subscription,
            alerts: [body.alert],
          }),
        });
        return relayScheduler(response, origin);
      }

      const stored = await storeAlert(env, body.subscription, body.alert);
      await noteNext(env, stored.fireAt);
      return json({ ok: true, ...stored }, 200, origin);
    }

    /* Batch form used by the app: one subscription write for all milestones. */
    if (url.pathname === '/alerts' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400, origin);
      }

      if (!validSubscription(body.subscription)) {
        return json({ error: 'subscription must include endpoint, keys.p256dh, keys.auth' }, 400, origin);
      }
      if (!Array.isArray(body.alerts) || body.alerts.length === 0
          || body.alerts.length > MAX_ALERT_BATCH || !body.alerts.every(validAlert)) {
        return json({ error: `alerts must be 1-${MAX_ALERT_BATCH} valid alert objects` }, 400, origin);
      }

      if (env.SCHEDULER) {
        const subId = await subIdFor(body.subscription.endpoint);
        const response = await schedulerStub(env).fetch('https://scheduler/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subId,
            subscription: body.subscription,
            alerts: body.alerts,
          }),
        });
        return relayScheduler(response, origin);
      }

      const subId = await storeSubscription(env, body.subscription);
      const fireAt = [];
      for (const alert of body.alerts) {
        fireAt.push(await storeOneAlert(env, subId, alert));
      }
      await noteNext(env, Math.min(...fireAt));
      return json({ ok: true, subId, alerts: body.alerts.length, fireAt }, 200, origin);
    }

    if (url.pathname === '/alert' && request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id is required' }, 400, origin);
      if (env.SCHEDULER) {
        const response = await schedulerStub(env).fetch(
          `https://scheduler/alert?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
        return relayScheduler(response, origin);
      }
      await env.ALERTS.delete(`alert:${id}`);
      return json({ ok: true }, 200, origin);
    }

    /* Diagnostics below are unauthenticated: they only report counts and
       can trigger a scan of alerts that are already due. */
    if (url.pathname === '/alerts') {
      if (env.SCHEDULER) {
        const response = await schedulerStub(env).fetch('https://scheduler/alerts');
        return relayScheduler(response, origin);
      }
      const listed = await env.ALERTS.list({ prefix: 'alert:' });
      return json({ count: listed.keys.length }, 200, origin);
    }

    /* Diagnostics: shows which settings are present and whether a VAPID
       signature can be produced, without exposing any secret values. */
    if (url.pathname === '/selftest') {
      const report = {
        alertsBinding: Boolean(env.ALERTS),
        vapidPrivateJwk: Boolean(env.VAPID_PRIVATE_JWK),
        vapidPublicKey: Boolean(env.VAPID_PUBLIC_KEY),
        vapidSubject: Boolean(env.VAPID_SUBJECT),
        publicKeyLength: (env.VAPID_PUBLIC_KEY || '').length,
        now: Date.now(),
      };
      try {
        vapidConfig(env);
        const headers = await vapidHeaders(
          'https://web.push.apple.com/probe',
          JSON.parse(env.VAPID_PRIVATE_JWK),
          env.VAPID_PUBLIC_KEY,
          env.VAPID_SUBJECT,
        );
        report.vapidSigns = String(headers.Authorization || '').startsWith('vapid t=');
      } catch (error) {
        report.vapidSigns = false;
        report.error = String(error && error.message ? error.message : error);
      }
      try {
        if (env.SCHEDULER) {
          const response = await schedulerStub(env).fetch('https://scheduler/status');
          const status = await response.json();
          report.alerts = status.count;
          report.scheduler = 'durable-object';
        } else {
          const listed = await env.ALERTS.list({ prefix: 'alert:' });
          report.alerts = listed.keys.length;
          report.scheduler = 'next-pointer';
        }
      } catch (error) {
        report.error = String(error && error.message ? error.message : error);
      }
      return json(report, 200, origin);
    }

    /* Runs the same scan as the cron, to check sending without waiting. */
    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        if (env.SCHEDULER) {
          const response = await schedulerStub(env).fetch('https://scheduler/run', {
            method: 'POST',
          });
          return relayScheduler(response, origin);
        }
        const result = await sendDueAlerts(env);
        return json({ ok: true, ...result }, 200, origin);
      } catch (error) {
        return json({ ok: false, error: String(error && error.message ? error.message : error) }, 500, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.SCHEDULER) {
        await sendDueAlerts(env);
        return;
      }

      /* Watchdog: normally the DO alarm sends; this only acts if the alarm
         is missing or badly overdue, and re-arms otherwise. */
      const response = await schedulerStub(env).fetch('https://scheduler/watchdog', {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`scheduler watchdog ${response.status}`);
    })().catch((error) => {
      console.error('scheduled run failed', error);
    }));
  },
};
