# Jimmy Transit Tracker

A one-screen-per-page iPhone web app showing the next arrivals for the
buses around Braemar Hill and in Wimbledon, London, in six swipeable
pages: **Citybus**, **Taikoo ↔ New Trend**, **KMB**, **Minibuses**,
**London** and **Info**.

**Citybus** — routes **27**, **85**, **25A** and **25** (outbound):

| Route | Stops |
|-------|-------|
| 27 | 4 — New Trend Plaza, King's Road |
| 85 | 23 Taikoo Place · 26 Healthy Village (King's Rd) · 30 New Trend Plaza · 36 Hanking Court (Cloud View Rd) · 41 Kiangsu-Chekiang College (Braemar Hill Rd) |
| 25A | 1 — Exhibition Centre Station · 23 — Flora Garden, Cloud View Road |
| 25 | 1 — Central Ferry, Man Kwong Street · 31 — Flora Garden, Cloud View Road |

Stop groups are shown in this order: **Taikoo Place**, **New Trend Plaza**,
**Hanking Court**, **Kiangsu-Chekiang College**, **Healthy Village**,
**Flora Garden**, **Central Ferry**, **Exhibition Centre**, then any
remaining stops. The order is set by `stopOrder` for the Citybus page in
`bake.py` (the name comes from the government feed, so it is “Hanking
Court”, not “Hangking”).

**KMB** — route **108**, with two outbound and one inbound stop:

| Direction | Stops |
|-----------|-------|
| Outbound (Kai Yip → Braemar Hill) | 17 — Cross Harbour Tunnel BBI · 22 — St. Paul's Hospital |
| Inbound (Braemar Hill → Kai Yip) | 4 — Flora Garden |

**Minibuses** — green minibus **25** and **49M**:

| Route | Stop |
|-------|------|
| 25 | 3 — Near Hilltop, Cloud View Road |
| 25 | 8 — Paterson Street, outside Pearl City Mansion |
| 49M | 1 — Tin Hau Station Bus Terminus |
| 49M | 3 — No. 39 Cloud View Road |

**London** — TfL buses around Wimbledon:

| Route | Direction | Stops |
|-------|-----------|-------|
| 57 | towards Kingston | South Wimbledon Station · Wimbledon Theatre · Wimbledon Station · Francis Grove · Darlaston Road |
| 57 | towards Clapham Park | Fairfield Bus Station · Darlaston Road |
| 131 | towards Kingston | South Wimbledon Station · Wimbledon Theatre · Wimbledon Station · Francis Grove · Darlaston Road |
| 131 | towards Tooting Broadway | Fairfield Bus Station · Darlaston Road |
| 93 | towards North Cheam | Wimbledon Village · Wimbledon Hill Road · Wimbledon Station |
| 93 | towards Putney Bridge | Morden Road Tram Stop · South Wimbledon Station · Wimbledon Hill Road |

**Taikoo ↔ New Trend** — both directions:

- **Taikoo Place → New Trend Plaza:** routes **77**, **81**, **81A**,
  **85**, **85A**, **8H**, **99** and **N8X**, with stop groups at Taikoo
  Place (departures) and New Trend Plaza (arrivals).
- **New Trend area → Taikoo area:** eastbound buses use different poles.
  The nearest departure stop is **Tin Chong Street** (19 m from New Trend
  Plaza) and the nearest arrival stop is **Sunway Gardens** (about 160 m
  from Taikoo Place). Routes: **102**, **106**, **116**, **15A**, **2**,
  **2A**, **307P**, **678**, **77**, **81**, **8H**, **99**, **N122** and
  **N8X**, with departure and arrival groups at those two stops.

**Info** — lists the live-data endpoints, app version and build date/time,
and API call counts for Citybus, KMB, Minibuses, TfL and the push worker:
**Launch** (since this launch) and **Install** (stored on the device across
relaunches), each with the time of the last call, its relative age (`just
now`, `5 min ago`, `2 days ago`) and a short date when the call was not made
today. Only real network requests are counted, so cache hits are free.

Live data comes from the Transport Department's **eTA GMB** API
(`data.etagmb.gov.hk`), the **Citybus** batch Stop-ETA API
(`rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{stop_id}`), the
**KMB** ETA API
(`data.etabus.gov.hk/v1/transport/kmb/eta/{stop_id}/{route}/{service_type}`)
and **TfL**'s Line Arrivals API
(`api.tfl.gov.uk/Line/{line}/Arrivals`). No API key, no account,
and no backend for arrivals — an optional worker handles push alerts only.

Citybus's per-route ETA endpoint (`/v2/transport/citybus/eta/CTB/{route}/{stop}`)
currently returns an empty list for every route, so the app uses the batch
Stop-ETA endpoint instead: one request per physical stop returns every
route's arrivals there. Each Citybus card is labelled with where the bus
is going (`→ Braemar Hill`, `→ Central (Ferry Piers)`, …) because a few
poles serve more than one direction.

## What it does

- Six pages — **Citybus**, **Taikoo ↔ New Trend**, **KMB**,
  **Minibuses**, **London** and **Info**. A tab bar under the status line
  jumps straight to any page (it highlights the current one and scrolls
  itself into view), and swiping left/right still works. Each page keeps
  its own scroll position.
- **Every page is lazy.** The app loads only the page on screen: one batch
  Stop-ETA request per Citybus stop, one per Taikoo stop, one per route +
  stop for KMB/GMB, and one per TfL line. That page refreshes every 30 s
  while it is visible, and refetches immediately when you return to it
  after more than ten seconds. Nothing polls in the background, including
  the page of a tracked bus (its countdown keeps running from the pinned
  time; swipe back to re-sync the prediction).
- Shows the next 3 buses for each saved stop, with a large countdown and
  the actual arrival clock time with seconds underneath (e.g. `12 min`
  above `21:48:30`).
- **Tap any arrival** to pin it: a bar under the status line counts down
  every second (`4:37` above `08:12:45`), beeps one minute before and when
  the bus is due, and clears itself shortly afterwards. Tap the same
  arrival or the `×` to stop. The choice survives refreshes and reloads.
- The tracked bar has a **Keep screen on** chip (Wake Lock) so the display
  stays awake while you watch a bus approach.
- With the optional push worker deployed, the same bar has an **Alerts
  10 → 0 min** chip: Web Push notifications labelled **10, 8, 6, 4, 2 and
  0 minutes**, each sent **one minute earlier than its label** (the 10-minute
  alert arrives about 11 minutes before the bus, "due" arrives one minute
  before), with the route, stop and stop ID. If the live prediction moves
  earlier and a milestone would be missed, it is sent immediately instead of
  being skipped. The app beeps and flashes the countdown at the labels
  themselves. See `worker/README.md`.
- Where the operator publishes a vehicle ID (TfL), each arrival also shows
  the fleet bus ID.
- Arrivals are grouped by **stop and direction**, not by route: each stop
  heading shows the direction, distance and stop ID, with every route
  serving that stop listed underneath.
- The **Taikoo ↔ New Trend** page uses the same grouping in both
  directions: Taikoo Place/New Trend Plaza, plus Tin Chong Street and
  Sunway Gardens for the nearest eastbound stops.
- Stops served by more than one route, or with groups in both directions,
  get a matching lighter card background so the group stands out.
- Citybus and KMB arrivals are colour-coded: green/grey entries are **live**
  (GPS-based) predictions, and blue entries are **scheduled** times. Live
  data is shown wherever the operator publishes it; scheduled times fill the
  remaining slots.
- Refreshes every 30 seconds while the screen is open (see the loading
  notes above for which pages refresh when).
- Remembers the last page you were on, and paints the last good arrivals
  from a local snapshot on relaunch (`Cached · updating…`) until the first
  live refresh lands, so a cold start is never blank.
- Uses your location to highlight the nearest stop *on the page you are
  looking at* in a strip at the top, and to show the straight-line distance
  to every saved stop in its heading. Network-level accuracy is used, since
  only straight-line distances are shown; nearest-stop times are only
  fetched for pages whose data is already loaded. Location is optional —
  the saved stops always work.
- Installable to the Home Screen; runs full-screen with its own icon (a
  green transit badge with a bus and a route pin, drawn as vector artwork in
  `icons/icon.svg`).
- Each page heading carries a small colour-coded operator mark: yellow for
  **Citybus** (also used on the Taikoo page, which runs on Citybus data), red
  for **KMB**, green for the **minibuses**, blue for **London (TfL)** and
  green for **Info**. These are original marks, not the operators' official
  logos.
- Works in light and dark mode.

## Tracking a bus

Tap any arrival chip to pin it. A bar appears under the status line with the
route, direction, stop name and stop ID, a countdown in `m:ss`, and the
predicted arrival time with seconds. It keeps ticking while the app is open
(and catches up instantly if iOS suspends the app), beeps at one minute and
at zero, and clears itself two minutes after the bus is due.

- Tap the same arrival, or the `×`, to stop tracking.
- **Keep screen on** asks for a screen Wake Lock so the display does not dim
  while you watch a bus.
- The tracked arrival is remembered in `localStorage`, so a reload or a
  30-second refresh keeps it.
- Live predictions drift by a few seconds between polls; the app adopts the
  refreshed time when it is clearly the same bus, and re-arms the alert if
  the predicted time moves by more than a minute.

## Push alerts (optional)

iOS has no scheduled local notifications for web apps, and a service worker
cannot wake itself, so a notification while the phone is locked needs a
push sender. `worker/` is a small Cloudflare Worker (free plan) that stores
one alert per milestone (10, 8, 6, 4, 2 and 0 minutes) in a Durable Object
and fires each from an alarm at the due time; KV remains as a fallback when
the Durable Object binding is absent.

This one is deployed at
`https://jimmy-transit-push.jimhickey.workers.dev` and configured in
`PUSH_ENDPOINT` in `app.js`. Setup notes, including how to redeploy or rotate
keys, are in **`worker/README.md`**. The VAPID public key is in `app.js`; the
private key stays in `worker/.vapid/` and in the Cloudflare secret, never in
git.

Limits to expect:

- iOS only allows web push for apps added to the **Home Screen**, and only
  after the user allows notifications from a tap.
- Delivery is best effort: Low Power Mode, Focus and notification summaries
  can delay or group it by a few minutes.
- It sends **six** notifications per tracked bus — 10, 8, 6, 4, 2 and 0
  minutes before it is due. Milestones already in the past when you tap the
  chip are skipped, so tracking a bus 7 minutes out arms 6, 4, 2 and 0.
- If the bus is under two minutes away there is nothing left to schedule, so
  the chip says **Under 2 min away**.
- iOS may group or briefly delay consecutive notifications, especially in
  Focus or Low Power Mode.

## Run it locally

```sh
cd jimmy-transit
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (A server is needed because browsers
block service workers on `file://`.)

## Releasing

```sh
python3 release.py 2.6.1     # stamp version, build time and cache
git add -A && git commit -m "…" && git push
```

`release.py` sets `APP_BUILD` to the current Hong Kong time and bumps the
service-worker cache name (`bus-times-vN`), so the HTML, JS and cached shell
always ship together. Without an argument it only re-stamps the build time.

## Put it on the iPhone

The app needs to be served over **HTTPS** for the Home Screen install and
for location access. Any static host works.

### GitHub Pages

1. Create a new repository, e.g. `jimmy-transit`.
2. Upload everything in this folder (not the folder itself).
3. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from
   a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. Open `https://<your-username>.github.io/jimmy-transit/` in Safari on the
   iPhone.
5. Tap **Share → Add to Home Screen**.

### Cloudflare Pages / Netlify

Drag this folder onto Cloudflare Pages or Netlify. Both give an HTTPS URL
immediately; no build command, no output directory (it is a static site).

## Changing the saved stops

The stops are defined in `bake.py`, in three lists:

- `MINIBUS_ROUTES` — `bookmarks` are minibus stop sequence numbers.
- `CITYBUS_ROUTES` — `direction` is `outbound` or `inbound`, and
  `bookmarks` are stop sequence numbers in that direction.
- `KMB_ROUTES` — `bound` is `outbound` or `inbound`, `service_type` is the
  KMB variant (1 for the normal 108), and `bookmarks` are stop sequence
  numbers in that direction.

Change the numbers, then rebuild the static data:

```sh
python3 bake.py
```

The script rewrites `data.js` and prints what it saved for each route.
It bakes each stop's ID, English name and coordinates, so the app makes no
route/stop lookup calls at runtime.

At runtime, Citybus rows are matched to a card by `route` and stop `seq`.
The direction flag in the feed is not used for matching, because Citybus
labels it inconsistently; the card instead shows the `dest` of the buses it
is listing. When a pole serves two directions, the card keeps the group
arriving soonest and labels it with that group's destination.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The app shell: header, status line, page tabs, pager |
| `styles.css` | iOS-style light/dark theme, pager and cards |
| `app.js` | Fetching, paging, nearest-stop logic, rendering |
| `data.js` | Generated route and stop data (names + coordinates) |
| `bake.py` | Regenerates `data.js` from the two government APIs |
| `manifest.json` | Home Screen install metadata |
| `sw.js` | Caches the app shell, and handles push notifications |
| `icons/` | App icons |
| `worker/` | Optional Cloudflare Worker that sends the 5-minute push alert |

## Notes and limits

- Both APIs publish **arrival times**, not vehicle GPS positions. The app
  shows minutes to each stop; it does not draw buses on a map.
- Outside service hours the feeds return empty lists and the cards show
  “No arrivals right now”.
- Citybus cards are built from the stop lists chosen in `bake.py` (all
  outbound stop numbers). The destination on each card shows which way the
  listed buses are actually travelling.
- Citybus does not label scheduled rows explicitly in its open data. The
  app treats a row as scheduled when its ETA falls exactly on the minute
  (`20:30:00`); live GPS predictions include seconds (`20:29:47`). This
  matches the “Scheduled” label in the official Citybus app. On the rare
  occasion a live prediction lands exactly on `:00`, it will be shown as
  scheduled.
- KMB labels scheduled rows explicitly in `rmk_en` as `Scheduled Bus`; the
  app shows those in the same blue style. Only the normal 108 (service
  type 1) is tracked, in the directions shown above.
- London arrivals come from TfL's StopPoint API and their clock times are
  shown in London time (`Europe/London`), whatever the phone's timezone.
- TfL predictions include a fleet vehicle ID, shown as `Bus …` on the
  London cards. Citybus, KMB and GMB open data do not publish vehicle IDs,
  so those pages do not show one.
- The London page groups arrivals by **physical stop** (pole), with a
  **“towards” summary of the ultimate destinations** served there — so 57 and
  131 share one group where they call at the same pole, and the summary lists
  both destinations. **Darlaston Road towards Clapham Park & Tooting
  Broadway** is first, then Darlaston Road towards Kingston; the other stops
  are ordered by distance from you (nearest first). Location off falls back
  to Darlaston Road, Wimbledon Station, Francis Grove, then the rest.
- Hong Kong bus clock times are shown in Hong Kong time
  (`Asia/Hong_Kong`), so they stay correct when travelling.
- The **Taikoo ↔ New Trend** page shows next departures and arrivals at
  both ends of each direction. The reverse direction uses the nearest
  eastbound stops (Tin Chong Street → Sunway Gardens) because eastbound
  buses do not use the Taikoo Place/New Trend Plaza poles. Citybus does not
  expose vehicle IDs, so the lists are not paired bus-by-bus.
- The distance in each stop heading is the straight-line distance (“as the
  crow flies”) from your last known position, shown only when location
  access is allowed. It is not a routed walking path and needs no extra map
  service.
- If every Citybus card is empty for a long stretch during service hours,
  the Citybus feed itself may be down; it usually recovers without a change
  here. The minibus page is unaffected.
- 49M also has a rarely-used “Po Luen Path” detour variant; this app shows
  the normal route only.
- Stop names come from the government feeds and are in English.
