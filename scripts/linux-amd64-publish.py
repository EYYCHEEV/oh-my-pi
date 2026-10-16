#!/usr/bin/env python3
"""Publish one qualified Linux-amd64 tuple and retain verified public pins only."""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

_SPEC = importlib.util.spec_from_file_location("linux_amd64_receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(receipt)
ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = receipt.REPOSITORY
PREFIX = f"repos/{REPOSITORY}"
OID = r"[0-9a-f]{40}"
TAG = r"stronk-omp-s1-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{4}"
require = receipt.require


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's usual error includes untrusted argument values and paths.
        raise ValueError("Invalid publication arguments")


def environment():
    result = os.environ.copy()
    # The CLI's standard credential lookup remains untouched. Never inspect it.
    # Disable debugging and interactive helpers; all child output stays private.
    result.update(GH_HOST="github.com", GH_DEBUG="", GH_PROMPT_DISABLED="1", GH_PAGER="cat", PAGER="cat")
    return result


def command(arguments, *, data=None, output=subprocess.PIPE, timeout=120):
    return subprocess.run(["gh", *arguments], input=data, stdout=output,
                          stderr=subprocess.PIPE, env=environment(), timeout=timeout, check=False)


def api(endpoint, *, method="GET", body=None, absent=False):
    require(endpoint.startswith(PREFIX + "/") and ".." not in endpoint, "Invalid API endpoint")
    arguments = ["api", "--hostname", "github.com", "--include", "--method", method,
                 "--header", "Accept: application/vnd.github+json", endpoint]
    data = None
    if body is not None:
        arguments += ["--input", "-"]
        data = json.dumps(body, separators=(",", ":")).encode()
    result = command(arguments, data=data)
    # Parse only the captured HTTP status and JSON. Never print or persist bodies.
    header, separator, payload = result.stdout.partition(b"\r\n\r\n")
    if not separator:
        header, separator, payload = result.stdout.partition(b"\n\n")
    first = header.splitlines()[0] if header else b""
    status_match = re.fullmatch(rb"HTTP/[0-9.]+ ([0-9]{3})(?: [^\r\n]*)?", first)
    require(separator and status_match, "Unrecognized API response")
    status_code = int(status_match[1])
    value = receipt.strict_json(payload)
    if absent and status_code == 404 and result.returncode != 0:
        require(isinstance(value, dict) and value.get("message") == "Not Found", "Unrecognized missing release response")
        return None
    require(result.returncode == 0 and status_code in (200, 201), "GitHub request failed")
    return value


def witness(path, now=None):
    require(path.is_file() and not path.is_symlink(), "A public immutability witness is required")
    value = receipt.strict_json(path.read_text())
    receipt.keys(value, ("repository", "enabled", "observed_at"))
    require(value["repository"] == REPOSITORY and value["enabled"] is True, "Repository immutability must be approved and enabled")
    observed = value["observed_at"]
    require(isinstance(observed, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)", observed), "Witness must have a UTC timestamp")
    timestamp = datetime.fromisoformat(observed.replace("Z", "+00:00"))
    age = (now or datetime.now(timezone.utc)) - timestamp
    require(timedelta(0) <= age <= timedelta(hours=24), "Immutability witness is not recent")
    return timestamp


def remote_tag(tag, tag_object, commit):
    reference = api(f"{PREFIX}/git/ref/tags/{tag}")
    require(isinstance(reference, dict) and reference.get("ref") == f"refs/tags/{tag}", "Remote tag reference differs")
    require(reference.get("object", {}).get("type") == "tag" and reference["object"].get("sha") == tag_object, "Remote annotated tag differs")
    annotated = api(f"{PREFIX}/git/tags/{tag_object}")
    require(isinstance(annotated, dict) and annotated.get("sha") == tag_object and annotated.get("tag") == tag,
            "Remote tag identity differs")
    require(annotated.get("object", {}).get("type") == "commit" and annotated["object"].get("sha") == commit,
            "Remote direct source differs")


def unused_release(tag):
    # Listing includes authenticated drafts; the exact endpoint closes the list race.
    page = 1
    while True:
        releases = api(f"{PREFIX}/releases?per_page=100&page={page}")
        require(isinstance(releases, list), "Invalid release list")
        require(all(isinstance(item, dict) and isinstance(item.get("tag_name"), str) for item in releases), "Invalid release identity")
        require(not any(item["tag_name"] == tag for item in releases), "Existing releases and drafts cannot be reused")
        if len(releases) < 100:
            break
        page += 1
        require(page <= 10000, "Release list exceeded the verification bound")
    require(api(f"{PREFIX}/releases/tags/{tag}", absent=True) is None, "Existing release cannot be reused")


def release_identity(value, tag, commit, release_id, *, draft):
    require(isinstance(value, dict), "Invalid release identity")
    require(type(value.get("id")) is int and value["id"] > 0 and (release_id is None or value["id"] == release_id), "Release ID differs")
    require(value.get("tag_name") == tag and value.get("target_commitish") == commit and value.get("name") == tag, "Release source identity differs")
    require(value.get("draft") is draft and value.get("prerelease") is False, "Release state differs")
    if not draft:
        require(value.get("immutable") is True, "Published release is not immutable")
    return value["id"]


def asset_identities(value, expected, recorded=None):
    assets = value.get("assets")
    require(isinstance(assets, list) and len(assets) == len(receipt.ASSETS), "Release must contain exactly three assets")
    found = {}
    for item in assets:
        require(isinstance(item, dict), "Invalid asset identity")
        name = item.get("name")
        require(isinstance(name, str) and name in expected and name not in found, "Unexpected release asset")
        asset_id = item.get("id")
        require(type(asset_id) is int and asset_id > 0 and item.get("state") == "uploaded", "Invalid uploaded asset identity")
        require(type(item.get("size")) is int and item["size"] == expected[name]["size"], "Asset size differs")
        require(recorded is None or asset_id == recorded[name]["id"], "Asset ID differs")
        found[name] = {"id": asset_id, "name": name, **expected[name]}
    require(len({item["id"] for item in found.values()}) == len(receipt.ASSETS), "Asset IDs must be distinct")
    return found


def downloaded_assets(directory, assets):
    for name in receipt.ASSETS:
        item = assets[name]
        path = directory / (name + ".readback")
        # A fixed API asset-ID endpoint lets gh's authenticated HTTP transport own
        # redirect handling. No signed URL or Authorization header is extracted,
        # logged, or replayed by this program to another origin.
        with path.open("xb") as output:
            result = command(["api", "--hostname", "github.com", "--method", "GET",
                              "--header", "Accept: application/octet-stream",
                              f"{PREFIX}/releases/assets/{item['id']}"], output=output, timeout=600)
        require(result.returncode == 0, "Asset download failed")
        require(path.stat().st_size == item["size"] and receipt.digest(path) == item["sha256"], "Downloaded asset bytes differ")
        path.unlink()


def snapshot(source, destination):
    require(source.is_dir() and {item.name for item in source.iterdir()} == set(receipt.ASSETS), "Only the exact public asset set is permitted")
    for name in receipt.ASSETS:
        # No symlinks or special files, even if the source changes while copying.
        descriptor = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as original:
            require(stat.S_ISREG(os.fstat(original.fileno()).st_mode), "Assets must be regular files")
            with (destination / name).open("xb") as target:
                shutil.copyfileobj(original, target, length=1024 * 1024)
        (destination / name).chmod(0o600)


def publish(args):
    require(args.publish, "Explicit publication approval is required")
    require(re.fullmatch(OID, args.commit) and re.fullmatch(OID, args.recipe_commit) and re.fullmatch(TAG, args.tag), "Exact source, recipe, and tag inputs are required")
    require(args.commit == receipt.APPLICATION_COMMIT, "Wrong exact application source")
    approved_at = witness(args.immutability_witness)
    receipt.assert_recipes(ROOT, args.recipe_commit)
    tag_object = receipt.validate_tag(ROOT, args.commit, args.tag, args.allowed_signers, args.revoked_signers)
    with tempfile.TemporaryDirectory(prefix="linux-amd64-publish-") as temporary:
        private = Path(temporary)
        assets_dir = private / "assets"
        assets_dir.mkdir(mode=0o700)
        snapshot(args.assets, assets_dir)
        manifest = receipt.verify(assets_dir, args.commit, args.tag, True, recipe_commit=args.recipe_commit, root=ROOT)
        require(manifest["source"]["tag_object"] == tag_object, "Receipt signed tag differs")
        receipt.verify_attestation(manifest, args.attestation, args.qualification_signers)
        expected = {name: {"size": (assets_dir / name).stat().st_size, "sha256": receipt.digest(assets_dir / name)}
                    for name in receipt.ASSETS}
        # Reserve before any remote mutation, never replace an existing pin file.
        # A failure intentionally leaves an empty reservation, not success evidence.
        descriptor = os.open(args.pins, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as pins:
            remote_tag(args.tag, tag_object, args.commit)
            unused_release(args.tag)
            require(datetime.now(timezone.utc) - approved_at <= timedelta(hours=24), "Immutability witness expired")
            created = api(f"{PREFIX}/releases", method="POST", body={
                "tag_name": args.tag, "target_commitish": args.commit, "name": args.tag,
                "draft": True, "prerelease": False, "generate_release_notes": False, "make_latest": "false"})
            release_id = release_identity(created, args.tag, args.commit, None, draft=True)
            require(created.get("assets") == [], "New draft already contains assets")
            # gh owns its normal upload endpoint and credential handling. No
            # --clobber and no release-create fallback; upload only these snapshots.
            uploaded = command(["release", "upload", args.tag, *[str(assets_dir / name) for name in receipt.ASSETS],
                                "--repo", f"github.com/{REPOSITORY}"], timeout=1800)
            require(uploaded.returncode == 0, "Asset upload failed")
            draft = api(f"{PREFIX}/releases/{release_id}")
            release_identity(draft, args.tag, args.commit, release_id, draft=True)
            recorded = asset_identities(draft, expected)
            downloaded_assets(private, recorded)
            remote_tag(args.tag, tag_object, args.commit)
            # Approval was checked before any mutation; publication has no retry.
            require(datetime.now(timezone.utc) - approved_at <= timedelta(hours=24), "Immutability witness expired")
            published = api(f"{PREFIX}/releases/{release_id}", method="PATCH", body={"draft": False, "make_latest": "false"})
            release_identity(published, args.tag, args.commit, release_id, draft=False)
            asset_identities(published, expected, recorded)
            exact = api(f"{PREFIX}/releases/{release_id}")
            release_identity(exact, args.tag, args.commit, release_id, draft=False)
            asset_identities(exact, expected, recorded)
            by_tag = api(f"{PREFIX}/releases/tags/{args.tag}")
            release_identity(by_tag, args.tag, args.commit, release_id, draft=False)
            asset_identities(by_tag, expected, recorded)
            downloaded_assets(private, recorded)
            remote_tag(args.tag, tag_object, args.commit)
            record = {"schema": 1, "repository": REPOSITORY, "tag": args.tag, "tag_object": tag_object,
                      "commit": args.commit, "recipe_commit": args.recipe_commit, "target": "linux-amd64",
                      "release_id": release_id, "assets": [recorded[name] for name in receipt.ASSETS]}
            pins.write(json.dumps(record, sort_keys=True, indent=2) + "\n")
            pins.flush()
            os.fsync(pins.fileno())
    return record


def main():
    try:
        parser = Parser(description=__doc__)
        for name in ("commit", "recipe-commit", "tag"):
            parser.add_argument("--" + name, required=True)
        for name in ("assets", "allowed-signers", "immutability-witness", "pins", "attestation", "qualification-signers"):
            parser.add_argument("--" + name, type=Path, required=True)
        parser.add_argument("--revoked-signers", type=Path)
        parser.add_argument("--publish", action="store_true")
        publish(parser.parse_args())
    except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        raise SystemExit("Linux-amd64 publication refused or read-back failed; no automatic release repair is permitted.") from None
    print("Public linux-amd64 release pins recorded.")


if __name__ == "__main__":
    main()
