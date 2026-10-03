# Hermes Mobile 1.3.0: security notes (Play review + audit trail)

## Linux runtime (proot, arm64-only)
The on-device gateway runs a Debian rootfs under proot as the app UID.
No root, no setuid, no system partition changes. The proot binary is
bundled inside the APK (version-pinned 5.1.107.95) and the single rootfs
image is fetched over HTTPS with a dual sha256 check (compiled pin plus
live .sha256 asset) that fails closed with the expected hash in the
error. The old multi-step path (Termux .deb downloads, AnLinux rootfs,
on-device apt/pip) is deleted: install refuses non-arm64 devices loudly
instead of downloading and executing code at runtime. Audit flag HM-01
(specialUse) was rejected: the foreground service is dataSync only.

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

## Key design (deliberate, documented for review)
The EncryptedSharedPreferences master key (AES256-GCM, AndroidKeyStore) is
NOT bound to biometric/lockscreen auth and has no rotation schedule: the
gateway must start after reboot with no user present, so a key that
invalidates on biometric enrollment or lockscreen removal would brick
autostart. Rotation happens only on proven corruption (AEAD tag mismatch
wipes prefs + keystore entry and rebuilds). Writes fail closed when the
secure store is in fallback or direct-boot mode. Residual risk (physical
access plus a newly enrolled biometric) is accepted and stated here.

## Download disclosure (Deceptive Behavior rule)
Before anything downloads, the setup wizard shows what the 305MB image is
(source: official Hermes GitHub releases, SHA-256 verified fail-closed,
runs on-device only without root) behind an explicit checkbox; Start setup
stays disabled until it is checked (`discloseTitle/discloseBody/discloseConsent`
in `src/constants/languages.ts`, gating in `OnboardingWizard.tsx`). The Play
Console executable-code question is answered Yes with this same text.
