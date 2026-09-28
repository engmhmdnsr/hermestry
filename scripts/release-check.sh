#!/usr/bin/env bash
# Release check (SEC-01 / REL-01): fail if a release APK is debuggable.
# Usage: scripts/release-check.sh path/to/app-release.apk
# Passes when the merged manifest has no debuggable=true. Fails when
# debuggable=true is present, the APK is missing, or no inspector tool
# (apkanalyzer, aapt2, aapt) is available.
set -euo pipefail

APK="${1:-}"
if [ -z "$APK" ]; then
  echo "usage: $0 path/to/app-release.apk" >&2
  exit 2
fi
if [ ! -f "$APK" ]; then
  echo "FAIL: APK not found: $APK" >&2
  exit 1
fi

DUMP=""
if command -v apkanalyzer >/dev/null 2>&1; then
  DUMP="$(apkanalyzer manifest print "$APK" 2>/dev/null || true)"
elif command -v aapt2 >/dev/null 2>&1; then
  DUMP="$(aapt2 dump xmltree "$APK" --file AndroidManifest.xml 2>/dev/null || true)"
elif command -v aapt >/dev/null 2>&1; then
  DUMP="$(aapt dump xmltree "$APK" AndroidManifest.xml 2>/dev/null || true)"
else
  echo "FAIL: no APK inspector found (need apkanalyzer, aapt2, or aapt)" >&2
  exit 1
fi

if [ -z "$DUMP" ]; then
  echo "FAIL: could not read merged manifest from $APK" >&2
  exit 1
fi

# Match debuggable=true in either binary-dump form (E: ... A: ...="true")
# or raw XML form (android:debuggable="true"). Case-sensitive on purpose:
# manifest values are lowercase, anything else is a separate problem.
if printf '%s' "$DUMP" | grep -Eq 'debuggable[^=]*=[^a-zA-Z0-9]*"?true'; then
  echo "FAIL: $APK has debuggable=true in the merged manifest" >&2
  exit 1
fi

echo "PASS: $APK is not debuggable"
