# Jimmy Transit push worker

Sends **Web Push notifications** for the 10/8/6/4/2 milestones, an
**arriving** alert and a **departing** alert. The app’s **Settings → Push
notifications buffer** decides the lead: **2 min** (labels at 12/10/8/6/4,
arriving 2 before, departing at arrival), **1 min** (11/9/7/5/3, arriving 1
before, departing at arrival) or **Off** (10/8/6/4/2, arriving at arrival,
departing one minute after). The client computes the fire times.

It is a single Cloudflare Worker (free plan is enough): alerts and
subscriptions live in a **Durable Object** whose alarm sends at the due
second, with a KV/next-pointer fallback if the binding is absent and a
one-minute cron watchdog. The app itself stays static on GitHub Pages.

- `POST /alert` — store a subscription and one scheduled alert
- `POST /alerts` — batch form: one subscription write plus up to 12 alerts
  (the app uses this for the 10/8/6/4/2/0 milestones)
- `DELETE /alert?id=…` — cancel an alert
- `GET /health` — liveness check
- `GET /selftest` — shows which settings are present and whether a VAPID
  signature can be produced (no secret values are returned)
- `POST /run` — runs the same scan as the cron, without waiting for it
- cron `* * * * *` — send anything that is due, then delete it

Payloads are encrypted with RFC 8291 (`aes128gcm`) and signed with RFC 8292
VAPID, so the notification text shows the route, stop and stop ID.

## 1. Keys

`make-vapid.py` (macOS `openssl`, no packages) writes
`worker/.vapid/keys.json` and prints the two values you need. It is already
generated for this app:

- **Public key** — `PUSH_VAPID_KEY` in `app.js`, and the `VAPID_PUBLIC_KEY`
  variable in the worker.
- **Private key (JWK)** — only ever stored as the Cloudflare secret
  `VAPID_PRIVATE_JWK`. Never commit it; `.vapid/` is git-ignored.

Re-run `python3 worker/make-vapid.py` only if you want to rotate keys.
Rotating them invalidates existing browser subscriptions.

## 2. Deploy — Cloudflare dashboard (no CLI needed)

1. **Workers & Pages → Create → Worker**, name it `jimmy-transit-push`,
   deploy the hello-world, then **Edit code** and replace the contents with
   `worker/worker.js`. Deploy.
2. **Storage & Databases → KV → Create namespace**, name it `ALERTS`.
3. Worker → **Settings → Bindings → Add → KV namespace**:
   Variable name `ALERTS`, namespace `ALERTS`.
4. Worker → **Settings → Variables and Secrets**:
   - Variable `VAPID_PUBLIC_KEY` = the public key above
   - Variable `VAPID_SUBJECT` = `mailto:you@example.com` (any address or
     https URL; Apple requires one of those two forms)
   - Secret `VAPID_PRIVATE_JWK` = the whole private JWK JSON (one line)
5. Worker → **Settings → Trigger Events → Cron Triggers → Add**:
   `* * * * *` (every minute).
6. Copy the worker URL, e.g.
   `https://jimmy-transit-push.<your-subdomain>.workers.dev`, into
   `PUSH_ENDPOINT` in `app.js`.

Check it with `curl https://…workers.dev/health` — you should see
`{"ok":true,…}`.

## 3. Deploy — wrangler (if you install Node)

```sh
cd worker
npx wrangler kv namespace create ALERTS     # paste the id into wrangler.toml
npx wrangler secret put VAPID_PRIVATE_JWK    # paste the private JWK
npx wrangler deploy
```

`VAPID_SUBJECT` is set in `wrangler.toml`; add `VAPID_PUBLIC_KEY` there too
(or as a secret) before deploying.

## 4. Test the crypto without deploying

```sh
python3 -m http.server 8000
# open http://localhost:8000/worker/test/push-test.html
```

It encrypts a payload the way the worker does, decrypts it with a fresh
subscriber key, rejects a tampered ciphertext, and verifies the VAPID JWT
signature. All checks should pass.

## KV usage

The cron reads the single `meta:next` pointer once a minute and only performs
a KV `list` when something is actually due. This matters on the free plan:
the old once-a-minute scan used 1,440 list operations a day against a
1,000/day allowance. Normal days now use roughly 24 idle scans plus one scan
per batch of due alerts; reads stay around 1,440/day (100,000 allowed).
Do not change the cron back to listing every minute.

## Durable Object scheduler (second-level timing)

The cron trigger cannot run more often than once a minute, so **this
deployment uses a Durable Object**: alerts and subscriptions are stored in DO
storage (strongly consistent — KV list lag previously delayed sends by up to
a minute), and an **alarm** fires at the next `fireAt`, sends, and schedules
the next one. No KV polling is involved in this mode.

`wrangler.toml` declares the `SCHEDULER` binding and the `v1` migration
(`new_sqlite_classes`, free plan). Deploy from `worker/` with
`npx wrangler deploy`; `/health` reports `"scheduler":"durable-object"`.

The minute cron remains a watchdog: it calls the DO only if the alarm is
missing or more than two minutes overdue. Without the binding the worker
falls back to the KV + `meta:next` path and `/health` reports
`"next-pointer"`.

The client is unchanged. With the DO enabled, alerts can land within a few
seconds of their scheduled time instead of within the minute, though iOS
delivery remains best effort.

## 5. Using it on the phone

1. The app must be on the Home Screen (iOS only allows web push there), and
   the worker URL must be set in `app.js` and deployed.
2. Tap an arrival to track it, then tap **Alerts 10 → 0 min** and allow
   notifications (tap the chip once more after the permission prompt).
3. The chip turns green (**Alerts on · 10→0**). Tap it again to cancel.
4. Notifications look like `85 in 10 min`, `85 in 8 min`, …, `85 departing`,
   each with `Healthy Village · Stop 001276 · → North Point`.

Notes and limits:

- Milestones already in the past when you arm are skipped, so tracking a bus
  7 minutes out arms 6, 4, 2 and 0. If the prediction later moves earlier and
  a milestone is missed, the app re-schedules it to fire immediately instead
  of skipping it. When nothing can be scheduled the chip says **Too close
  for alerts**.
- iOS delivery is best effort. Low Power Mode, Focus and notification
  summaries can delay or group a notification; the worker cannot guarantee
  a minute-accurate delivery.
- Tracking a live ETA re-arms the alert if the predicted time moves by more
  than a minute.
- Each alert and subscription is written with a KV TTL, so abandoned records
  expire on their own (alerts within a day, subscriptions after 120 days).
- The cron runs 1,440 times a day, well inside the free plan allowance.
  Cloudflare's cron fires on the minute, so the alert is within a minute of
  the five-minute mark.
