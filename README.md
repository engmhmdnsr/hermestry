# Hermes Mobile v1.1.9 (sideload)

Separate app from Hermes Control. Package `ee.oversight.hermes.mobile`.
On-phone Hermes gateway, external models only (you enter your own key, no default).
Local on-device LLM is phase 2, not in this build.

## What v1 does
- Setup tab: provider + API key + model id + telegram/discord tokens + local api key,
  Install (downloads the prebuilt image once, ~305MB, ready to run),
  Start/Stop foreground service on localhost:8080, auto-start on boot (WorkManager,
  safe on Android 12+).
  First run also gets a wizard: welcome, install (live logs), keys, start.
- Chat tab: sessions drawer, real SSE streaming against the on-phone gateway
  (event: names tracked like Hermes Control, mid-stream approvals surface inline),
  thinking blocks, tool lines, approvals (allow once / deny), rename/fork/delete.
- Jobs tab: cron CRUD (every 1h, every monday 9am, or 5-field cron).
- System tab: gateway status from /health/detailed + gateway.log tail + app log.
- Dark desktop-style theme (void + violet/cyan, same identity as Hermes Control).

## Notes
- Use a SEPARATE telegram bot token from your PC gateway (same token = 409 conflict).
- Debian + proot URLs live in `install/Bootstrap.kt` (arch auto-detected).
- First install needs network + ~500MB free space + patience (extraction is slow).

## Build
debug only (sideload): `./gradlew.bat assembleDebug --no-daemon`,
APK at `app/build/outputs/apk/debug/app-debug.apk`.
