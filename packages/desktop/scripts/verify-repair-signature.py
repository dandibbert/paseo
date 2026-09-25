#!/usr/bin/env python3
"""Verify personal ad-hoc packages without modifying any signature or OS policy."""

import argparse
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path

REQUIRED = (
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
)


def validate_metadata(label, metadata, entitlements):
    if "Signature=adhoc" not in metadata:
        raise ValueError(f"{label}: expected the personal ad-hoc signature")
    match = re.search(r"flags=0x([0-9a-fA-F]+)", metadata)
    if not match or not int(match.group(1), 16) & 0x10000:
        raise ValueError(f"{label}: Hardened Runtime must remain enabled")
    missing = [key for key in REQUIRED if entitlements.get(key) is not True]
    if missing:
        raise ValueError(f"{label}: missing signed entitlements: {', '.join(missing)}")


def self_test():
    valid = dict.fromkeys(REQUIRED, True)
    metadata = "Signature=adhoc\nCodeDirectory flags=0x10002(adhoc,runtime)"
    validate_metadata("valid", metadata, valid)
    for key in REQUIRED:
        missing = dict(valid)
        missing.pop(key)
        try:
            validate_metadata("missing entitlement", metadata, missing)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Accepted missing entitlement: {key}")
    for bad in ("Signature=adhoc\nflags=0x2(adhoc)", "Signature=Developer ID\nflags=0x10000(runtime)"):
        try:
            validate_metadata("wrong policy", bad, valid)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted wrong signing policy")
    build = Path(__file__).resolve().parents[1] / "build"
    with (build / "entitlements.mac.repair.plist").open("rb") as file:
        repair = plistlib.load(file)
    for filename in ("entitlements.mac.plist", "entitlements.mac.inherit.plist"):
        with (build / filename).open("rb") as file:
            original = plistlib.load(file)
        # The repair must retain existing permissions and add only this exception.
        expected = {**original, "com.apple.security.cs.disable-library-validation": True}
        if repair != expected:
            raise AssertionError(f"Repair permissions diverge from {filename}")
        try:
            validate_metadata("repair.6 baseline", metadata, original)
        except ValueError as error:
            if "disable-library-validation" not in str(error):
                raise
        else:
            raise AssertionError("Baseline no longer reproduces the missing entitlement")
    print("Signature policy regression checks passed (old policy rejected, repair accepted).")


def verify(app_path):
    if sys.platform != "darwin":
        raise ValueError("Signed bundle verification requires macOS")
    app = app_path.resolve(strict=True)
    if app.suffix != ".app":
        raise ValueError("Expected an .app bundle")
    framework = app / "Contents/Frameworks/Electron Framework.framework/Electron Framework"
    if not framework.is_file() or not framework.resolve().is_relative_to(app):
        raise ValueError("Embedded Electron Framework is missing or escapes the app")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True)
    helpers = sorted((app / "Contents/Frameworks").rglob("*.app"))
    if not helpers:
        raise ValueError("No Electron helper bundles found")
    reports = []
    for bundle in [app, *helpers]:
        with (bundle / "Contents/Info.plist").open("rb") as file:
            executable_name = plistlib.load(file)["CFBundleExecutable"]
        executable = bundle / "Contents/MacOS" / executable_name
        if not executable.resolve(strict=True).is_relative_to(app):
            raise ValueError(f"Executable escapes app: {executable}")
        metadata = subprocess.run(
            ["codesign", "--display", "--verbose=4", str(executable)],
            check=True, capture_output=True, text=True,
        )
        entitlement_result = subprocess.run(
            ["codesign", "--display", "--entitlements", ":-", str(executable)],
            check=True, capture_output=True,
        )
        entitlements = plistlib.loads(entitlement_result.stdout)
        details = metadata.stdout + metadata.stderr
        label = str(bundle.relative_to(app.parent))
        validate_metadata(label, details, entitlements)
        reports.append({"bundle": label, "entitlements": entitlements, "signature": details})
    print(json.dumps({"app": str(app), "verifiedBundles": reports}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--self-test", action="store_true")
    target.add_argument("--app", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        verify(args.app)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print(f"Signature verification failed: {error}", file=sys.stderr)
        sys.exit(1)
