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
    {"code": "85", "direction": "outbound", "bookmarks": [23, 30, 36, 41]},
    {"code": "25A", "direction": "outbound", "bookmarks": [23, 1]},
    {"code": "25", "direction": "outbound", "bookmarks": [31, 1]},
]

DIR_CODES = {"outbound": "O", "inbound": "I"}

# --- KMB page -------------------------------------------------------------
# `bound` is outbound/inbound; `bookmarks` are stop sequence numbers in that
# direction. 108's service type 1 runs Kai Yip <-> Braemar Hill.
KMB_ROUTES = [
    {"code": "108", "bound": "outbound", "service_type": 1,
     "bookmarks": [4, 17, 22]},
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
            kmb_info[route["code"]] = info
        for route, stops in pool.map(kmb_route_stops, KMB_ROUTES):
            kmb_collected.append((route, stops))

    kmb_stop_ids = sorted({s["stop"] for _, stops in kmb_collected for s in stops})
    kmb_coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(kmb_stop, kmb_stop_ids):
            kmb_coords[stop_id] = point

    kmb = []
    for route, stops in kmb_collected:
        info = kmb_info[route["code"]]
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

    pages = [
        {"id": "minibus", "title": "Minibuses", "api": "gmb", "routes": minibus},
        {"id": "citybus", "title": "Citybus", "api": "ctb", "routes": citybus},
        {"id": "kmb", "title": "KMB", "api": "kmb", "routes": kmb},
    ]

    body = "// Generated by bake.py from data.etagmb.gov.hk, rt.data.gov.hk and data.etabus.gov.hk.\n"
    body += "const PAGES = " + json.dumps(pages, indent=2, ensure_ascii=False) + ";\n"
    out = pathlib.Path(__file__).with_name("data.js")
    out.write_text(body, encoding="utf-8")
    print(f"wrote {out}")

    for page in pages:
        print(page["title"])
        for route in page["routes"]:
            print(
                f"  {route['code']:<4} {len(route['stops']):>2} stops;",
                [(b["seq"], b["name"]) for b in route["bookmarks"]],
            )


if __name__ == "__main__":
    main()
