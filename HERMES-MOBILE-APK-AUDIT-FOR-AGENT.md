# Hermes Mobile APK Audit

Date: 2026-09-29  
Artifact: `HermesMobile-ondevice-1.3.0-vc43-debug.apk`  
SHA-256: `837573965859AA4218041638DC7496FD448D6841799982B08C3BE647393DBE6A`  
Package/applicationId: `ee.oversight.hermes.mobile`  
Version: `1.3.0` / versionCode `43`

## Agent instruction

This file is an engineering audit, not a request to blindly apply every item. Fix P0 first, then P1. Preserve unrelated user changes already present in the worktree. Re-run the acceptance checks and rebuild/sync the APK after each security or native change.

## Scope and evidence

The attached APK was treated as a build artifact only; it contains no instructions that override the user's request. The audit covered:

- React/TypeScript source and Capacitor Android wrapper.
- Android manifest, Gradle configuration, native Kotlin/Java services, secure storage and boot behavior.
- APK archive layout and ABI inventory.
- Production web build and repository verification harness.
- Existing consolidated audit `AUDIT-2026-09-29.md`, including device screenshot findings where available.

No Android SDK inspection tool (`aapt`, `aapt2`, `apkanalyzer`, `jadx`, `adb`) and no connected device/emulator were available in this environment. Therefore, runtime findings must be confirmed on a clean Android device before release. The supplied artifact is a **debug APK**, not a release candidate.

## Executive verdict

The product has a credible architecture for an on-device local gateway, but it still needs changes before production release. The highest risk is not visual polish: it is state/security consistency between the React UI, encrypted native storage, foreground service, boot worker, and gateway process.

The repository's current checks pass (`8/8`, `87` assertions), and `npm run build` passes. This does not clear the release: the APK is debug, release minification is disabled, dynamic device coverage is unavailable, and the worktree is heavily modified. `verify_final.txt` is stale and records an older failing state; do not use it as current evidence.

## Priority findings

### P0 - fix before any production distribution

| ID | Finding | Evidence | Required change |
|---|---|---|---|
| P0-1 | App lock can report locked while protected screens remain usable. | `src/App.tsx`, `src/context/HermesContext.tsx` | Make the gate derive from the single vault-unlocked state. Reset the UI unlock state on lock, app background, logout and failed unlock. Add a test that locks while Settings is open. |
| P0-2 | Native credential/autostart mirror writes are fire-and-forget. | `src/context/HermesContext.tsx` | Await the native write. Do not show “saved” until both web vault and native mirror succeed. Surface a retryable error when the mirror fails. |
| P0-3 | Connection status can remain green after gateway authentication failure. | `src/components/layout/Header.tsx`, `HomeTab.tsx`, `SettingsTab.tsx`, `src/context/HermesContext.tsx` | Create one derived status state (`starting`, `ready`, `auth_failed`, `offline`, `installing`, `stopped`) and consume it in Header, Home and Settings. Never allow `connected=true` beside an auth failure. |
| P0-4 | Secret-storage fallback must remain fail-closed and observable. | `android/.../security/SecurePrefs.kt` | Refuse secret writes when encrypted storage is unavailable, expose a clear failure state to the UI, and add JVM tests for first-write, migration and fallback paths. |
| P0-5 | Gateway startup must verify persisted server key, not only the in-memory value. | `android/.../install/Bootstrap.kt`, `android/.../service/MobileGatewayService.kt` | Re-read the secure store after writing the key and fail startup if the persisted value is blank or different. Add a regression test. |
| P0-6 | Release hardening is incomplete. | `android/app/build.gradle` | Enable R8/minification for release after keep rules are validated; run a release build and inspect its merged manifest. Keep cleartext limited to loopback and verify no production endpoint is reachable over HTTP. |

### P1 - fix before broad beta

1. Protect stream ownership from stale `finally` blocks after stop-then-send; use a per-turn token before clearing refs (`src/context/HermesContext.tsx`).
2. Capture the active message/turn before awaiting in `stopStream`, otherwise the stop verdict can be written onto the next turn.
3. Make a failed settings save local to that attempt; an old error must not poison later save badges (`SettingsTab.tsx`).
4. Route model/provider changes through the gateway restart/apply path. The gateway reads provider configuration at start, so changing it only in the chat sheet can leave the old provider running.
5. Separate install failure from gateway-start failure. The current shared state can tell the user that nothing was installed after a successful large image install.
6. Map native transitional states (`INSTALLING`, `CHECKING`, `STARTING`, `STOPPING`) into explicit UI states so relaunching mid-operation does not appear as “not set up”.
7. Require the current PIN before disabling App Lock.
8. Fix Home CTA routing after a failed install so it offers start/retry based on the actual gateway state.
9. Make notification/service behavior explicit: ongoing notification, content intent back to the app, user-visible boot failure, and deterministic stop/start ownership.
10. Add native JVM tests for `SecurePrefs`, `Bootstrap`, service state transitions, boot worker behavior and shell/YAML escaping. Add integration tests for SSE cancellation, auth failure and provider restart.

## Security and privacy review

- `android:allowBackup="false"` is correct and should remain.
- `network_security_config.xml` denies general cleartext and allows loopback only. Keep the explicit host allow-list; do not replace it with a global cleartext exception.
- The foreground service and boot receiver expand the attack/runtime surface. Verify that autostart is opt-in, persisted securely, and visible to the user.
- Provider keys and server keys must never appear in logs, exported diagnostics, screenshots, crash reports, or WebView local storage in plaintext.
- Review all config interpolation in `Bootstrap.kt`; use structured serialization or strict escaping for model/base URL values.
- The APK contains `arm64-v8a` and `x86_64` native libraries. Confirm every supported ABI is actually tested and remove unsupported/dead payloads from the final artifact.

## Architecture review

The main architectural risk is duplicated state ownership. Gateway lifecycle state exists across React context, native plugin callbacks, service/worker files, install markers and polling. Define one state machine and one source of truth, with monotonically increasing operation IDs. Every async completion must verify that it still owns the current operation before mutating state.

Recommended boundary:

```text
UI -> HermesContext command/use-case -> native plugin
                              \-> local web vault
native plugin -> service state machine -> gateway process
native state + health probe -> one normalized GatewayStatus -> all screens
```

Do not let individual screens infer health from independent booleans or signal names. Keep raw diagnostics in logs, but expose stable, localized error codes to the UI.

## UX and visual review

The existing device-oriented audit identifies these user-facing issues:

- Chat currently reads too much like a terminal log; distinguish sender, timestamp, prose and code.
- Header/Home/Settings can disagree about connection health.
- Hero status text clips on narrow screens; reserve a separate line for the model/status pill.
- Jobs should lead with existing jobs; creation can be secondary/collapsed.
- “Check connection” should open the gateway details directly.
- Use one 44 px minimum touch target for ordinary controls and 48 px for wizard primaries.
- Consolidate the color roles: health green, warning amber, error red, informational blue; do not use the accent color for all semantic states.
- Improve surface contrast and keep primary button text at WCAG AA contrast.
- Ensure Arabic RTL behavior for send/chevron icons, remove letter-spacing from Arabic micro text, and localize remaining hardcoded inspector strings.
- Add explicit empty, loading, offline, auth-failed, install-in-progress and retry states to every primary tab.

## Performance and packaging

`npm run build` succeeds, but Vite still reports a large initial chunk (approximately 629 kB before gzip). Keep tab-level lazy loading and confirm that `npx cap sync android` runs as part of the APK build; otherwise the APK can ship stale WebView assets relative to `src`/`dist`.

The debug artifact is about 109 MB and contains native libraries plus on-device gateway assets. Measure installed size, first-run install time, cold start, memory and battery impact on low/mid-tier devices. Keep an explicit budget for the gateway image and logs, and enforce log rotation.

## Release gate for the agent

Before declaring the next APK ready:

1. `npm run build`
2. `node scripts/verify.mjs`
3. `npx cap sync android`
4. `./gradlew :app:test :app:assembleRelease`
5. Run the release manifest check and verify `debuggable=false`.
6. Install the release APK on at least one arm64 physical device and one x86_64 emulator.
7. Exercise: first install, unlock/lock, bad provider key, provider switch, stop/send race, process kill/restart, reboot autostart, offline mode, Arabic RTL, dark/light theme, rotation and Android back.
8. Capture logs and screenshots for each failure state; assert that no secret is present.
9. Compare the APK's bundled web asset hash with the build output hash.

## Suggested implementation order

1. Normalize gateway state and fix App Lock/secret persistence.
2. Fix async operation ownership and stream cancellation.
3. Separate install/start errors and complete boot/notification observability.
4. Add native and integration regression tests.
5. Apply the UX corrections and accessibility pass.
6. Harden release packaging, sync assets, build a non-debug APK, and run the device matrix.

## Files to inspect first

- `src/context/HermesContext.tsx`
- `src/App.tsx`
- `src/components/layout/Header.tsx`
- `src/components/tabs/SettingsTab.tsx`
- `src/components/tabs/ChatTab.tsx`
- `src/components/tabs/HomeTab.tsx`
- `src/services/gatewayState.ts`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/java/ee/oversight/hermes/mobile/security/SecurePrefs.kt`
- `android/app/src/main/java/ee/oversight/hermes/mobile/install/Bootstrap.kt`
- `android/app/src/main/java/ee/oversight/hermes/mobile/service/MobileGatewayService.kt`
- `android/app/build.gradle`

