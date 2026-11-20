# Minibus 25 · 49M

A one-screen iPhone web app that shows the next arrivals for Hong Kong
green minibus routes **25** (Upper Braemar Hill ↔ Causeway Bay) and
**49M** (Tin Hau Station ↔ Braemar Hill) at four saved stops:

| Route | Stop |
|-------|------|
| 25 | 3 — Near Hilltop, Cloud View Road |
| 25 | 8 — Paterson Street, outside Pearl City Mansion |
| 49M | 1 — Tin Hau Station Bus Terminus |
| 49M | 3 — No. 39 Cloud View Road |

Live data comes from the Transport Department's **eTA GMB** API
(`data.etagmb.gov.hk`). No API key, no account, no backend.

## What it does

- Shows the next 3 buses for each saved stop, in minutes.
- Refreshes every 30 seconds while the screen is open.
- Uses your location to highlight the nearest minibus stop in a strip
  at the top. Location is optional — the four saved stops always work.
- Installable to the Home Screen; runs full-screen with its own icon.
- Works in light and dark mode.

## Run it locally

```sh
cd minibus-25-49m
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (A server is needed because browsers
block JavaScript modules and service workers on `file://`.)

## Put it on the iPhone

The app needs to be served over **HTTPS** for the Home Screen install and
for location access. Any static host works; the whole app is five files.

### Option A — GitHub Pages (free, permanent)

1. Create a new repository, e.g. `minibus-2549`.
2. Upload everything in this folder (not the folder itself).
3. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from
   a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. Open `https://<your-username>.github.io/minibus-2549/` in Safari on the
   iPhone.
5. Tap **Share → Add to Home Screen**.

### Option B — Cloudflare Pages / Netlify

Drag this folder onto Cloudflare Pages or Netlify. Both give an HTTPS URL
immediately; no build command, no output directory (it is a static site).

### Option C — quick test from this Mac

While the Mac is awake, a tunnel gives a temporary HTTPS URL:

```sh
cloudflared tunnel --url http://localhost:8000
```

Open the printed `https://…trycloudflare.com` URL on the phone. The URL
dies when the tunnel stops, so this is only for testing.

## Changing the saved stops

The four stops are defined in `bake.py`. Change the `bookmarks` lists
(stop sequence numbers), then rebuild the static data:

```sh
python3 bake.py
```

The script prints nothing else and rewrites `data.js`. No other file needs
to change.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The single screen |
| `styles.css` | iOS-style light/dark theme |
| `app.js` | Fetching, nearest-stop logic, rendering |
| `data.js` | Generated route and stop data (names + coordinates) |
| `bake.py` | Regenerates `data.js` from the government API |
| `manifest.json` | Home Screen install metadata |
| `sw.js` | Caches the app shell so it opens instantly |
| `icons/` | App icons |

## Notes and limits

- The API publishes **arrival times**, not vehicle GPS positions. The app
  shows minutes to your stop; it does not draw the bus on a map.
- Outside service hours the API returns an empty list, and the cards show
  “No arrivals right now”. Route 25 runs roughly 06:20–23:40.
- 49M also has a rarely-used “Po Luen Path” detour variant; this app shows
  the normal route only.
- Stop names come from the government feed and are in English.
