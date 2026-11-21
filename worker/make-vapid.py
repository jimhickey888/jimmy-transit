#!/usr/bin/env python3
"""Create a VAPID (P-256) keypair for the push worker.

Uses openssl (already on macOS) so no extra packages are needed. Writes
worker/.vapid/private.pem and worker/.vapid/keys.json, then prints the two
values the worker needs. Nothing here is committed to git.
"""

import base64
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
VAPID_DIR = HERE / ".vapid"
PEM = VAPID_DIR / "private.pem"


def b64url(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def blocks(text):
    """Split openssl's hex dump into the priv and pub byte strings."""
    priv, pub, seen = [], [], None
    for line in text.splitlines():
        if line.startswith("priv:"):
            seen = priv
            rest = line.split(":", 1)[1]
        elif line.startswith("pub:"):
            seen = pub
            rest = line.split(":", 1)[1]
        elif line.startswith(("ASN1", "NIST")):
            seen = None
            continue
        else:
            rest = line
        if seen is not None:
            seen.extend(rest.replace(":", " ").split())
    return bytes.fromhex("".join(priv)), bytes.fromhex("".join(pub))


def main():
    VAPID_DIR.mkdir(exist_ok=True)
    if not PEM.exists():
        subprocess.run(
            ["openssl", "ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", str(PEM)],
            check=True,
        )
        PEM.chmod(0o600)

    text = subprocess.run(
        ["openssl", "ec", "-in", str(PEM), "-text", "-noout"],
        check=True, capture_output=True, text=True,
    ).stdout
    private, public = blocks(text)

    private = private[-32:]  # openssl pads the scalar with a leading 0x00
    assert public[0] == 4 and len(public) == 65, "expected an uncompressed P-256 point"

    x, y = public[1:33], public[33:65]
    private_jwk = {
        "kty": "EC",
        "crv": "P-256",
        "d": b64url(private),
        "x": b64url(x),
        "y": b64url(y),
    }
    public_key = b64url(public)

    keys = VAPID_DIR / "keys.json"
    keys.write_text(json.dumps({"publicKey": public_key, "privateJwk": private_jwk}, indent=2) + "\n")
    keys.chmod(0o600)

    print("Public key — paste into app.js as PUSH_VAPID_KEY and into the")
    print("Cloudflare variable VAPID_PUBLIC_KEY:\n")
    print(public_key)
    print("\nPrivate key — store as the Cloudflare secret VAPID_PRIVATE_JWK:\n")
    print(json.dumps(private_jwk))
    print(f"\nSaved {keys}")


if __name__ == "__main__":
    main()
