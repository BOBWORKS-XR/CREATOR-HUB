"""Data-only preparatory checks; never authorizes acquisition or native execution."""
import base64
import hashlib
import json
import re

DEB = {"size": 64519358, "sha256": "61a32fe588280366c3d6f8b76323764867bca8c3537d30a45c33ed2302be4a43"}
HUB_SHA = "822e46106d5caaf36890965d3020fb49b2235e91517eb33bd5d2f4210d5b5690"
ASSET_NAME = "Creator_Hub_0.1.17_amd64-acceptance-only.deb"
ROLES = ("descriptor", "descriptorSignature", "latest", "installerSignature")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected), "Unexpected or missing fields")


def pin(value, maximum):
    keys(value, ("size", "sha256"))
    require(type(value["size"]) is int and 0 < value["size"] <= maximum
            and type(value["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Invalid pin")


def bound(raw, expected, maximum):
    pin(expected, maximum)
    require(type(raw) is bytes and len(raw) == expected["size"]
            and hashlib.sha256(raw).hexdigest() == expected["sha256"], "Pinned bytes differ")


def parse(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    require(type(raw) is bytes and 0 < len(raw) <= 32768, "JSON size differs")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))


def inspect(spec, release, listing, asset, members):
    """Check supplied draft metadata only; spec is not trusted authorization."""
    keys(spec, ("release", "tag", "asset", "name", "zip", "members"))
    require(type(spec["release"]) is int and spec["release"] > 0
            and type(spec["asset"]) is int and spec["asset"] > 0, "Exact API IDs required")
    require(type(spec["tag"]) is str and re.fullmatch(r"[A-Za-z0-9._-]{1,100}", spec["tag"])
            and type(spec["name"]) is str and re.fullmatch(r"[A-Za-z0-9._-]{1,160}\.zip", spec["name"]), "Invalid draft identity")
    pin(spec["zip"], 768 * 1024 * 1024)
    keys(spec["members"], ROLES); keys(members, ROLES)
    for role in ROLES:
        bound(members[role], spec["members"][role], 32768 if role in ("descriptor", "latest") else 4096)
    require(type(release) is dict and release.get("id") == spec["release"]
            and release.get("tag_name") == spec["tag"] and release.get("draft") is True, "Draft release differs")
    require(type(listing) is list and len(listing) < 100, "Complete bounded asset listing required")
    matches = [item for item in listing if type(item) is dict and
               (item.get("id") == spec["asset"] or item.get("name") == spec["name"])]
    require(len(matches) == 1 and matches[0].get("id") == spec["asset"]
            and matches[0].get("name") == spec["name"], "Asset alias or absence")
    require(type(asset) is dict and all(asset.get(k) == v for k, v in {
        "id": spec["asset"], "name": spec["name"], "size": spec["zip"]["size"],
        "state": "uploaded", "digest": "sha256:" + spec["zip"]["sha256"]}.items()), "Asset API differs")
    descriptor = parse(members["descriptor"])
    require(type(descriptor) is dict and all(descriptor.get(k) == v for k, v in {
        "appId": "creator-hub", "version": "0.1.17", "platform": "linux", "architecture": "x86_64",
        "packageType": "deb", "assetName": ASSET_NAME, "byteLength": DEB["size"],
        "sha256": DEB["sha256"], "executableSha256": HUB_SHA}.items()), "Audited 017 descriptor differs")
    latest = parse(members["latest"])
    require(type(latest) is dict and latest.get("version") == "0.1.17", "Updater version differs")
    platforms = latest.get("platforms"); keys(platforms, ("linux-x86_64-deb",))
    entry = platforms["linux-x86_64-deb"]
    require(type(entry) is dict and entry.get("url") ==
            "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/" + ASSET_NAME, "Updater URL differs")
    try:
        decoded = base64.b64decode(entry.get("signature", ""), validate=True)
    except (ValueError, TypeError):
        raise ValueError("Updater signature encoding differs") from None
    require(decoded == members["installerSignature"] and decoded.startswith(b"untrusted comment:"), "Installer signature bytes differ")
    return {"status": "DATA_ONLY_UNBOUND", "signatureVerified": False, "archiveVerified": False,
            "sourceReceiptVerified": False, "nativeExecutionAuthorized": False, "releaseReady": False}
