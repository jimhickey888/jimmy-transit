# Jimmy Transit push worker

Sends **one Web Push notification five minutes before a tracked bus is due**.
It is a single Cloudflare Worker (free plan is enough) with a KV namespace
and a one-minute cron trigger. The app itself stays static on GitHub Pages.

- `POST /alert` — store a subscription and one scheduled alert
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

## 5. Using it on the phone

1. The app must be on the Home Screen (iOS only allows web push there), and
   the worker URL must be set in `app.js` and deployed.
2. Tap an arrival to track it, then tap **Alert 5 min before** and allow
   notifications.
3. The chip turns green (**Alert on · 5 min**). Tap it again to cancel.
4. Notification text looks like `85 in 5 min` / `Healthy Village · Stop
   001276 · → North Point`.

Notes and limits:

- Alerts are only armed while the arrival is more than ~5 minutes away;
  closer than that the chip says **Under 5 min away** and nothing is sent.
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
