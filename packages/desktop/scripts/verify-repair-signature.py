#!/usr/bin/env python3
"""Verify personal packages without modifying any signature or OS policy.

Personal builds are signed with one self-signed certificate. macOS installs an
in-app update only when the new app satisfies the running app's designated
requirement, so that requirement must name the certificate, never a build hash.
"""

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


SIGNER = "Paseo Personal Signing"


def validate_identity(label, metadata):
    authorities = re.findall(r"^Authority=(.*)$", metadata, re.MULTILINE)
    if authorities != [SIGNER] or re.search(r"^Signature=adhoc", metadata, re.MULTILINE):
        raise ValueError(f"{label}: expected the {SIGNER} certificate signature")


def validate_requirement(label, requirement, cert_sha1):
    # Squirrel.Mac rejects an update whose signature fails this requirement.
    # A cdhash requirement changes with every build, so updates would never install.
    fingerprint = cert_sha1.replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{40}", fingerprint):
        raise ValueError("Expected a SHA-1 certificate fingerprint")
    match = re.search(r"^designated => (.+)$", requirement, re.MULTILINE)
    if not match:
        raise ValueError(f"{label}: no designated requirement")
    designated = match.group(1).strip()
    if "cdhash" in designated or f'h"{fingerprint}"' not in designated.lower():
        raise ValueError(f"{label}: designated requirement must pin the signing certificate")
    return designated


def validate_metadata(label, metadata, entitlements):
    validate_identity(label, metadata)
    match = re.search(r"flags=0x([0-9a-fA-F]+)", metadata)
    if not match or not int(match.group(1), 16) & 0x10000:
        raise ValueError(f"{label}: Hardened Runtime must remain enabled")
    missing = [key for key in REQUIRED if entitlements.get(key) is not True]
    if missing:
        raise ValueError(f"{label}: missing signed entitlements: {', '.join(missing)}")


def self_test():
    valid = dict.fromkeys(REQUIRED, True)
    signed = f"Authority={SIGNER}\nTeamIdentifier=not set"
    metadata = f"{signed}\nCodeDirectory flags=0x10000(runtime)"
    validate_metadata("valid", metadata, valid)
    # Frameworks need the same signing identity as the outer app, but executable
    # entitlements and Hardened Runtime are checked only on app/helper processes.
    validate_identity("Electron Framework", f"{signed}\nflags=0x0(none)")
    for bad in ("Authority=Developer ID Application: Electron\nTeamIdentifier=ELECTRON",
                f"Authority={SIGNER}\nAuthority=Apple Root CA",
                "Signature=adhoc\nflags=0x2(adhoc)", ""):
        try:
            validate_identity("Electron Framework", bad)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted an unsigned or differently signed framework")
    for key in REQUIRED:
        missing = dict(valid)
        missing.pop(key)
        try:
            validate_metadata("missing entitlement", metadata, missing)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Accepted missing entitlement: {key}")
    for bad in (f"{signed}\nflags=0x0(none)", "Signature=adhoc\nflags=0x10002(adhoc,runtime)"):
        try:
            validate_metadata("wrong policy", bad, valid)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted wrong signing policy")
    fingerprint = "EF:61:CD:CF:05:8F:8F:8A:7D:50:61:54:49:5B:B5:92:A7:5C:34:84"
    pinned = 'designated => identifier "sh.paseo.desktop" and certificate leaf = H"ef61cdcf058f8f8a7d506154495bb592a75c3484"'
    validate_requirement("pinned", pinned, fingerprint)
    for bad in ('designated => cdhash H"0123456789abcdef0123456789abcdef01234567"',
                pinned.replace("ef61", "aa61"), ""):
        try:
            validate_requirement("unpinned", bad, fingerprint)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted a requirement that blocks in-app updates")
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
    print("Signature policy regression checks passed (ad-hoc and unpinned signatures rejected).")


def verify(app_path, cert_sha1):
    if sys.platform != "darwin":
        raise ValueError("Signed bundle verification requires macOS")
    app = app_path.resolve(strict=True)
    if app.suffix != ".app":
        raise ValueError("Expected an .app bundle")
    framework = app / "Contents/Frameworks/Electron Framework.framework/Electron Framework"
    if not framework.is_file() or not framework.resolve().is_relative_to(app):
        raise ValueError("Embedded Electron Framework is missing or escapes the app")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True)
    requirement = subprocess.run(
        ["codesign", "--display", "--requirements", "-", str(app)],
        check=True, capture_output=True, text=True,
    )
    designated = validate_requirement(app.name, requirement.stdout + requirement.stderr, cert_sha1)
    # The same check Squirrel.Mac runs before it replaces the installed app.
    subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", f"-R={designated}", str(app)], check=True,
    )
    framework_metadata = subprocess.run(
        ["codesign", "--display", "--verbose=4", str(framework)],
        check=True, capture_output=True, text=True,
    )
    framework_details = framework_metadata.stdout + framework_metadata.stderr
    framework_label = str(framework.relative_to(app.parent))
    validate_identity(framework_label, framework_details)
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
    print(json.dumps({
        "app": str(app),
        "designatedRequirement": designated,
        "verifiedBundles": reports,
        "verifiedFrameworks": [{"framework": framework_label, "signature": framework_details}],
    }, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--self-test", action="store_true")
    target.add_argument("--app", type=Path)
    parser.add_argument("--cert-sha1", help="SHA-1 fingerprint of the personal signing certificate")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif not args.cert_sha1:
        parser.error("--app requires --cert-sha1")
    else:
        verify(args.app, args.cert_sha1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print(f"Signature verification failed: {error}", file=sys.stderr)
        sys.exit(1)
