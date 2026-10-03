# Hermes Mobile 1.3.0: security notes (Play review + audit trail)

## Linux runtime (proot)
The on-device gateway runs a Debian rootfs under proot as the app UID.
No root, no setuid, no system partition changes. The proot binary is
version-pinned (5.1.107.95, Termux apt) and the rootfs image is fetched
over HTTPS with a live sha256 check that fails closed with the expected
hash in the error. Audit flag HM-01 (specialUse) was rejected: the
foreground service is dataSync only.

## Tokens: native vs web
On Android, auth access/refresh tokens live ONLY in EncryptedSharedPreferences
slots (`lockout.authAccessToken`, `lockout.authRefreshToken`, `lockout.authUser`).
The `hermes.auth.*` localStorage keys in the JS bundle are the web fallback
path and are never written on native (see `persistUser`/`setTokens` in
`src/services/auth.ts`: native branch uses `nativeSet`, web branch uses `lsSet`).
Key names appearing as strings in the bundle are not stored values.

## Provider and server secrets
Provider API keys are kept in an encrypted vault map; stored provider entries
carry a `secretRef`, not the key. The app surfaces a visible warning when the
secure store falls back to plaintext (`secureStoreFallback`). The gateway
`API_SERVER_KEY` is generated on device and never leaves it.

## Local API surface
The gateway binds 127.0.0.1:8080 (loopback). The only non-loopback cleartext
exceptions are 127.0.0.1 and localhost. Bearer auth is required per request.

## Account backend
Auth points at one permanent origin, `https://www.oversight.ee/api`, which
proxies to the account service through a Cloudflare Tunnel (no public ports
on the server). No temporary tunnel hostnames ship in release builds:
`npm run release:scan` fails the build if one is present.

## Release hardening
Release builds set `debuggable=false` (debug builds set true; the manifest
carries no debuggable attribute). `scripts/release-check.sh` rejects any
release APK whose merged manifest has debuggable=true. No
MANAGE_EXTERNAL_STORAGE: file import uses SAF into the app sandbox with a
100MB cap.
