# Bus Times

A one-screen-per-page iPhone web app showing the next arrivals for the
buses around Braemar Hill, in three swipeable pages.

**Minibuses** — green minibus **25** and **49M**:

| Route | Stop |
|-------|------|
| 25 | 3 — Near Hilltop, Cloud View Road |
| 25 | 8 — Paterson Street, outside Pearl City Mansion |
| 49M | 1 — Tin Hau Station Bus Terminus |
| 49M | 3 — No. 39 Cloud View Road |

**Citybus** — routes **27**, **85**, **25A** and **25** (outbound):

| Route | Stops |
|-------|-------|
| 27 | 4 — New Trend Plaza, King's Road |
| 85 | 23 Taikoo Place · 30 New Trend Plaza · 36 Hanking Court (Cloud View Rd) · 41 Kiangsu-Chekiang College (Braemar Hill Rd) |
| 25A | 1 — Exhibition Centre Station · 23 — Flora Garden, Cloud View Road |
| 25 | 1 — Central Ferry, Man Kwong Street · 31 — Flora Garden, Cloud View Road |

**KMB** — route **108**, with one outbound and two inbound stops:

| Direction | Stops |
|-----------|-------|
| Outbound (Kai Yip → Braemar Hill) | 4 — Skyline Tower |
| Inbound (Braemar Hill → Kai Yip) | 17 — Valley Road Hung Hom · 22 — The Family Planning Association of HK |

Live data comes from the Transport Department's **eTA GMB** API
(`data.etagmb.gov.hk`), the **Citybus** batch Stop-ETA API
(`rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{stop_id}`) and the
**KMB** ETA API
(`data.etabus.gov.hk/v1/transport/kmb/eta/{stop_id}/{route}/{service_type}`).
No API key, no account, no backend.

Citybus's per-route ETA endpoint (`/v2/transport/citybus/eta/CTB/{route}/{stop}`)
currently returns an empty list for every route, so the app uses the batch
Stop-ETA endpoint instead: one request per physical stop returns every
route's arrivals there. Each Citybus card is labelled with where the bus
is going (`→ Braemar Hill`, `→ Central (Ferry Piers)`, …) because a few
poles serve more than one direction.

## What it does

- Three pages — **Minibuses**, **Citybus** and **KMB** — swipe left/right
  to switch, or tap the dots next to the status line. Each page keeps its
  own scroll position.
- Shows the next 3 buses for each saved stop, in minutes.
- Citybus and KMB arrivals are colour-coded: green/grey entries are **live**
  (GPS-based) predictions, and blue entries are **scheduled** times. Live
  data is shown wherever the operator publishes it; scheduled times fill the
  remaining slots.
- Refreshes every 30 seconds while the screen is open.
- Uses your location to highlight the nearest stop *on the page you are
  looking at* in a strip at the top, and to show the straight-line distance
  to every saved stop on its card. Location is optional — the saved
  stops always work.
- Installable to the Home Screen; runs full-screen with its own icon.
- Works in light and dark mode.

## Run it locally

```sh
cd minibus-25-49m
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (A server is needed because browsers
block service workers on `file://`.)

## Put it on the iPhone

The app needs to be served over **HTTPS** for the Home Screen install and
for location access. Any static host works.

### GitHub Pages

1. Create a new repository, e.g. `minibus-2549`.
2. Upload everything in this folder (not the folder itself).
3. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from
   a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. Open `https://<your-username>.github.io/minibus-2549/` in Safari on the
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
| `index.html` | The app shell: header, status line, page dots, pager |
| `styles.css` | iOS-style light/dark theme, pager and cards |
| `app.js` | Fetching, paging, nearest-stop logic, rendering |
| `data.js` | Generated route and stop data (names + coordinates) |
| `bake.py` | Regenerates `data.js` from the two government APIs |
| `manifest.json` | Home Screen install metadata |
| `sw.js` | Caches the app shell so it opens instantly |
| `icons/` | App icons |

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
- The distance on each card is the straight-line distance (“as the crow
  flies”) from your last known position, shown only when location access is
  allowed. It is not a routed walking path and needs no extra map service.
- If every Citybus card is empty for a long stretch during service hours,
  the Citybus feed itself may be down; it usually recovers without a change
  here. The minibus page is unaffected.
- 49M also has a rarely-used “Po Luen Path” detour variant; this app shows
  the normal route only.
- Stop names come from the government feeds and are in English.
