#!/usr/bin/env python3
"""Rebuild data.js from the official Hong Kong bus APIs.

Covers the Minibuses page (green minibus 25 and 49M, Transport Department
eTA GMB API), the Citybus page (Citybus 25, 25A, 27 and 85, data.gov.hk
Citybus API) and the KMB page (KMB 108, data.gov.hk KMB API).

Run this if a route changes its stops, or if you want different bookmarked
stops. Requires only the Python standard library.

    python3 bake.py
"""

import json
import pathlib
import urllib.request
import concurrent.futures

GMB = "https://data.etagmb.gov.hk"
CTB = "https://rt.data.gov.hk/v2/transport/citybus"
KMB = "https://data.etabus.gov.hk/v1/transport/kmb"
TFL = "https://api.tfl.gov.uk"

# --- Minibuses page -------------------------------------------------------
# `bookmarks` are stop_seq numbers (1-based) from the route's stop list.
MINIBUS_ROUTES = [
    {
        "code": "25",
        "route_id": 2002020,
        "route_seq": 1,
        "orig": "Upper Braemar Hill",
        "dest": "Causeway Bay (Circular)",
        "bookmarks": [3, 8],
    },
    {
        "code": "49M",
        "route_id": 2000988,
        "route_seq": 1,
        "orig": "Tin Hau Station",
        "dest": "Braemar Hill (Circular)",
        "bookmarks": [1, 3],
    },
]

# --- Citybus page ---------------------------------------------------------
# `direction` is outbound/inbound; `bookmarks` are stop_seq numbers in that
# direction.
CITYBUS_ROUTES = [
    {"code": "27", "direction": "outbound", "bookmarks": [4]},
    {"code": "85", "direction": "outbound", "bookmarks": [23, 26, 30, 36, 41]},
    {"code": "25A", "direction": "outbound", "bookmarks": [23, 1]},
    {"code": "25", "direction": "outbound", "bookmarks": [31, 1]},
]

DIR_CODES = {"outbound": "O", "inbound": "I"}

# --- KMB page -------------------------------------------------------------
# `bound` is outbound/inbound; `bookmarks` are stop sequence numbers in that
# direction. 108's service type 1 runs Kai Yip <-> Braemar Hill.
KMB_ROUTES = [
    {"code": "108", "bound": "outbound", "service_type": 1,
     "bookmarks": [17, 22]},
    {"code": "108", "bound": "inbound", "service_type": 1,
     "bookmarks": [4]},
]

# --- Taikoo Place -> New Trend Plaza page --------------------------------
# Routes whose stop order passes Taikoo Place (001273) before New Trend
# Plaza (001282). `dirCode` is only for reference; the app matches by seq.
SEGMENT_ROUTES = [
    {"code": "77", "route": "77", "dirCode": "I", "fromSeq": 19, "toSeq": 26},
    {"code": "81", "route": "81", "dirCode": "O", "fromSeq": 24, "toSeq": 32},
    {"code": "81A", "route": "81A", "dirCode": "O", "fromSeq": 19, "toSeq": 26},
    {"code": "85", "route": "85", "dirCode": "O", "fromSeq": 23, "toSeq": 30},
    {"code": "85A", "route": "85A", "dirCode": "O", "fromSeq": 12, "toSeq": 20},
    {"code": "8H", "route": "8H", "dirCode": "O", "fromSeq": 27, "toSeq": 34},
    {"code": "99", "route": "99", "dirCode": "I", "fromSeq": 19, "toSeq": 26},
    {"code": "N8X", "route": "N8X", "dirCode": "O", "fromSeq": 25, "toSeq": 33},
]

SEGMENT_FROM = {
    "stop_id": "001273",
    "name": "Taikoo Place, King's Road",
    "lat": 22.286667942091,
    "lon": 114.21039739053,
}
SEGMENT_TO = {
    "stop_id": "001282",
    "name": "New Trend Plaza, King's Road",
    "lat": 22.289909792091,
    "lon": 114.19515688053,
}

# --- London page (TfL) ----------------------------------------------------
# Fixed TfL StopPoint IDs; the second item is the label shown in the app.
# Each entry is one direction of a route.
TFL_ROUTES = [
    {
        "code": "57", "line": "57", "towards": "Kingston",
        "stops": [
            ("490000216C", "South Wimbledon Station"),
            ("490014742Y", "Wimbledon Theatre"),
            ("490015472L", "Wimbledon Station"),
            ("490006987M", "Francis Grove"),
            ("490005961W", "Darlaston Road"),
        ],
    },
    {
        "code": "57", "line": "57", "towards": "Clapham Park",
        "stops": [
            ("490006705B2", "Fairfield Bus Station"),
            ("490005961E", "Darlaston Road"),
        ],
    },
    {
        "code": "131", "line": "131", "towards": "Kingston",
        "stops": [
            ("490000216C", "South Wimbledon Station"),
            ("490014742Y", "Wimbledon Theatre"),
            ("490015472L", "Wimbledon Station"),
            ("490006987M", "Francis Grove"),
            ("490005961W", "Darlaston Road"),
        ],
    },
    {
        "code": "131", "line": "131", "towards": "Tooting Broadway",
        "stops": [
            ("490006705B2", "Fairfield Bus Station"),
            ("490005961E", "Darlaston Road"),
        ],
    },
    {
        "code": "93", "line": "93", "towards": "North Cheam",
        "stops": [
            ("490008184E", "Wimbledon Village"),
            ("490014734S", "Wimbledon Hill Road"),
            ("490015472D", "Wimbledon Station"),
        ],
    },
    {
        "code": "93", "line": "93", "towards": "Putney Bridge",
        "stops": [
            ("490002060A", "Morden Road Tram Stop"),
            ("490015174A", "South Wimbledon Station"),
            ("490014734R", "Wimbledon Hill Road"),
        ],
    },
]


def get(url):
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "curl/8"}
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


# --- minibus helpers ------------------------------------------------------


def gmb_route_stops(route):
    data = get(f"{GMB}/route-stop/{route['route_id']}/{route['route_seq']}")
    return route, data["data"]["route_stops"]


def gmb_stop(stop_id):
    data = get(f"{GMB}/stop/{stop_id}")["data"]
    wgs = data["coordinates"]["wgs84"]
    return stop_id, {"lat": wgs["latitude"], "lon": wgs["longitude"]}


# --- citybus helpers ------------------------------------------------------


def ctb_names():
    data = get(f"{CTB}/route/CTB")["data"]
    names = {}
    for item in data:
        names.setdefault(item["route"], (item["orig_en"], item["dest_en"]))
    return names


def ctb_route_stops(route):
    stops = get(f"{CTB}/route-stop/CTB/{route['code']}/{route['direction']}")["data"]
    return route, stops


def ctb_stop(stop_id):
    data = get(f"{CTB}/stop/{stop_id}")["data"]
    return stop_id, {"lat": float(data["lat"]), "lon": float(data["long"]),
                     "name": data["name_en"]}


# --- KMB helpers ----------------------------------------------------------


def kmb_route(route):
    data = get(f"{KMB}/route/{route['code']}/{route['bound']}/{route['service_type']}")["data"]
    return route, data


def kmb_route_stops(route):
    stops = get(f"{KMB}/route-stop/{route['code']}/{route['bound']}/{route['service_type']}")["data"]
    return route, stops


def kmb_stop(stop_id):
    data = get(f"{KMB}/stop/{stop_id}")["data"]
    return stop_id, {"lat": float(data["lat"]), "lon": float(data["long"]),
                     "name": data["name_en"]}


# --- London (TfL) helpers -------------------------------------------------


def tfl_stop(stop_id):
    data = get(f"{TFL}/StopPoint/{stop_id}")
    return stop_id, {"lat": float(data["lat"]), "lon": float(data["lon"])}


def main():
    # Minibuses ------------------------------------------------------------
    collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for route, stops in pool.map(gmb_route_stops, MINIBUS_ROUTES):
            collected.append((route, stops))

    gmb_stop_ids = sorted({s["stop_id"] for _, stops in collected for s in stops})
    gmb_coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(gmb_stop, gmb_stop_ids):
            gmb_coords[stop_id] = point

    minibus = []
    for route, stops in collected:
        minibus.append({
            "code": route["code"],
            "route_id": route["route_id"],
            "route_seq": route["route_seq"],
            "orig": route["orig"],
            "dest": route["dest"],
            "bookmarks": [
                {"seq": s["stop_seq"], "stop_id": s["stop_id"], "name": s["name_en"]}
                for s in stops if s["stop_seq"] in route["bookmarks"]
            ],
            "stops": [
                {
                    "seq": s["stop_seq"],
                    "stop_id": s["stop_id"],
                    "name": s["name_en"],
                    "lat": gmb_coords[s["stop_id"]]["lat"],
                    "lon": gmb_coords[s["stop_id"]]["lon"],
                }
                for s in stops
            ],
        })

    # Citybus --------------------------------------------------------------
    names = ctb_names()
    ctb_collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for route, stops in pool.map(ctb_route_stops, CITYBUS_ROUTES):
            ctb_collected.append((route, stops))

    ctb_stop_ids = sorted({s["stop"] for _, stops in ctb_collected for s in stops})
    ctb_coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(ctb_stop, ctb_stop_ids):
            ctb_coords[stop_id] = point

    citybus = []
    for route, stops in ctb_collected:
        orig, dest = names.get(route["code"], ("", ""))
        citybus.append({
            "code": route["code"],
            "route": route["code"],
            "direction": route["direction"],
            "dirCode": DIR_CODES[route["direction"]],
            "orig": orig,
            "dest": dest,
            "bookmarks": [
                {"seq": s["seq"], "stop_id": s["stop"], "name": ctb_coords[s["stop"]]["name"]}
                for s in stops if s["seq"] in route["bookmarks"]
            ],
            "stops": [
                {
                    "seq": s["seq"],
                    "stop_id": s["stop"],
                    "name": ctb_coords[s["stop"]]["name"],
                    "lat": ctb_coords[s["stop"]]["lat"],
                    "lon": ctb_coords[s["stop"]]["lon"],
                }
                for s in stops
            ],
        })

    # KMB ------------------------------------------------------------------
    kmb_info = {}
    kmb_collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for route, info in pool.map(kmb_route, KMB_ROUTES):
            kmb_info[(route["code"], route["bound"], route["service_type"])] = info
        for route, stops in pool.map(kmb_route_stops, KMB_ROUTES):
            kmb_collected.append((route, stops))

    kmb_stop_ids = sorted({s["stop"] for _, stops in kmb_collected for s in stops})
    kmb_coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(kmb_stop, kmb_stop_ids):
            kmb_coords[stop_id] = point

    kmb = []
    for route, stops in kmb_collected:
        info = kmb_info[(route["code"], route["bound"], route["service_type"])]
        kmb.append({
            "code": route["code"],
            "route": route["code"],
            "service_type": route["service_type"],
            "direction": route["bound"],
            "orig": info["orig_en"],
            "dest": info["dest_en"],
            "bookmarks": [
                {"seq": int(s["seq"]), "stop_id": s["stop"], "name": kmb_coords[s["stop"]]["name"]}
                for s in stops if int(s["seq"]) in route["bookmarks"]
            ],
            "stops": [
                {
                    "seq": int(s["seq"]),
                    "stop_id": s["stop"],
                    "name": kmb_coords[s["stop"]]["name"],
                    "lat": kmb_coords[s["stop"]]["lat"],
                    "lon": kmb_coords[s["stop"]]["lon"],
                }
                for s in stops
            ],
        })

    # London (TfL) ---------------------------------------------------------
    tfl_stop_ids = sorted({
        stop_id for route in TFL_ROUTES for stop_id, _ in route["stops"]
    })
    tfl_coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(tfl_stop, tfl_stop_ids):
            tfl_coords[stop_id] = point

    london = []
    for route in TFL_ROUTES:
        stops = [
            {
                "seq": i,
                "stop_id": stop_id,
                "name": name,
                "lat": tfl_coords[stop_id]["lat"],
                "lon": tfl_coords[stop_id]["lon"],
            }
            for i, (stop_id, name) in enumerate(route["stops"], start=1)
        ]
        london.append({
            "code": route["code"],
            "line": route["line"],
            "towards": route["towards"],
            "desc": f"towards {route['towards']}",
            "bookmarks": [
                {"seq": s["seq"], "stop_id": s["stop_id"], "name": s["name"]}
                for s in stops
            ],
            "stops": stops,
        })

    segment = [
        {
            "code": route["code"],
            "route": route["route"],
            "dirCode": route["dirCode"],
            "fromSeq": route["fromSeq"],
            "toSeq": route["toSeq"],
            "from": dict(SEGMENT_FROM),
            "to": dict(SEGMENT_TO),
        }
        for route in SEGMENT_ROUTES
    ]

    pages = [
        {"id": "citybus", "title": "Citybus", "api": "ctb", "routes": citybus},
        {"id": "kmb", "title": "KMB", "api": "kmb", "routes": kmb},
        {"id": "minibus", "title": "Minibuses", "api": "gmb", "routes": minibus},
        {"id": "segment", "title": "Taikoo", "subtitle": "→ New Trend Plaza · 8 routes",
         "api": "segment", "routes": segment,
         "from": dict(SEGMENT_FROM), "to": dict(SEGMENT_TO)},
        {"id": "london", "title": "London", "subtitle": "57 · 131 · 93 · London time",
         "api": "tfl", "routes": london,
         "stopOrder": ["Darlaston Road", "Wimbledon Station", "Francis Grove"]},
    ]

    body = "// Generated by bake.py from data.etagmb.gov.hk, rt.data.gov.hk, data.etabus.gov.hk and api.tfl.gov.uk.\n"
    body += "const PAGES = " + json.dumps(pages, indent=2, ensure_ascii=False) + ";\n"
    out = pathlib.Path(__file__).with_name("data.js")
    out.write_text(body, encoding="utf-8")
    print(f"wrote {out}")

    for page in pages:
        print(page["title"])
        for route in page["routes"]:
            if page["api"] == "segment":
                print(
                    f"  {route['code']:<4} Taikoo seq {route['fromSeq']}"
                    f" -> New Trend seq {route['toSeq']}"
                )
            else:
                print(
                    f"  {route['code']:<4} {len(route['stops']):>2} stops;",
                    [(b["seq"], b["name"]) for b in route["bookmarks"]],
                )


if __name__ == "__main__":
    main()
