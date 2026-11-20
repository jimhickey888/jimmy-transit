#!/usr/bin/env python3
"""Rebuild data.js from the Transport Department eTA GMB API.

Run this if a route changes its stops, or if you want different
bookmarked stops. Requires only the Python standard library.

    python3 bake.py
"""

import json
import pathlib
import urllib.request
import concurrent.futures

BASE = "https://data.etagmb.gov.hk"

# Edit these to change the saved stops. `bookmarks` are stop_seq numbers
# (1-based) from the route's stop list.
ROUTES = [
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


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Accept": "application/json", "User-Agent": "curl/8"},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def fetch_route(route):
    data = get(f"/route-stop/{route['route_id']}/{route['route_seq']}")
    return route, data["data"]["route_stops"]


def fetch_stop(stop_id):
    data = get(f"/stop/{stop_id}")["data"]
    wgs = data["coordinates"]["wgs84"]
    return stop_id, {"lat": wgs["latitude"], "lon": wgs["longitude"]}


def main():
    collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for route, stops in pool.map(fetch_route, ROUTES):
            collected.append((route, stops))

    stop_ids = sorted({s["stop_id"] for _, stops in collected for s in stops})
    coords = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for stop_id, point in pool.map(fetch_stop, stop_ids):
            coords[stop_id] = point

    routes = []
    for route, stops in collected:
        routes.append({
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
                    "lat": coords[s["stop_id"]]["lat"],
                    "lon": coords[s["stop_id"]]["lon"],
                }
                for s in stops
            ],
        })

    body = "// Generated from data.etagmb.gov.hk — static route geometry.\n"
    body += "const ROUTES = " + json.dumps(routes, indent=2, ensure_ascii=False) + ";\n"
    out = pathlib.Path(__file__).with_name("data.js")
    out.write_text(body, encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
