#!/usr/bin/env python3
"""Stamp a release for the static app.

Usage:
    python3 release.py 2.6.0     # set the version too
    python3 release.py           # keep the version, just re-stamp

It updates `APP_BUILD` in app.js to the current Hong Kong time and bumps the
service-worker cache name in sw.js, so every deploy ships a fresh shell and
the two never drift apart.
"""

import argparse
import pathlib
import re
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="?", help="new APP_VERSION, e.g. 2.6.0")
    args = parser.parse_args()

    now = datetime.now(ZoneInfo("Asia/Hong_Kong"))
    build = now.strftime("%-d %b %Y, %H:%M HKT")

    app = ROOT / "app.js"
    source = app.read_text()
    new_source, build_hits = re.subn(
        r"const APP_BUILD = '[^']*';",
        f"const APP_BUILD = '{build}';",
        source,
        count=1,
    )
    if build_hits != 1:
        raise SystemExit("could not find APP_BUILD in app.js")

    if args.version:
        new_source, version_hits = re.subn(
            r"const APP_VERSION = '[^']*';",
            f"const APP_VERSION = '{args.version}';",
            new_source,
            count=1,
        )
        if version_hits != 1:
            raise SystemExit("could not find APP_VERSION in app.js")
    app.write_text(new_source)

    sw = ROOT / "sw.js"
    sw_source = sw.read_text()
    match = re.search(r"const CACHE = 'bus-times-v(\d+)';", sw_source)
    if not match:
        raise SystemExit("could not find the shell cache name in sw.js")
    old_cache = int(match.group(1))
    sw_source = sw_source.replace(match.group(0), f"const CACHE = 'bus-times-v{old_cache + 1}';", 1)
    sw.write_text(sw_source)

    version = re.search(r"const APP_VERSION = '([^']+)';", new_source).group(1)
    print(f"version {version}")
    print(f"built   {build}")
    print(f"cache   bus-times-v{old_cache} -> bus-times-v{old_cache + 1}")


if __name__ == "__main__":
    main()
