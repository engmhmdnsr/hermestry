# Gateway security: loopback bind + auth + CORS (SEC-05 / SEC-06)

Scope: on-device gateway reachable only at `http://127.0.0.1:8080`.
The gateway Python implementation is a downloaded image, not in this repo,
so behavior below is verified by test (see `scripts/gateway-auth-check.sh`),
not by reading server code. `network_security_config.xml` and the Manifest
are owned by T1 and were not touched.

## 1. Loopback binding evidence (code, not config)

| Claim | Evidence |
|---|---|
| Bind host is `127.0.0.1` | `android/app/src/main/java/ee/oversight/hermes/mobile/service/MobileGatewayService.kt:263` sets `API_SERVER_HOST=127.0.0.1` |
| Bind port is `8080` | `MobileGatewayService.kt:264` sets `API_SERVER_PORT=8080` |
| Supervisor expects loopback | `MobileGatewayService.kt:158` logs `gateway listening on 127.0.0.1:8080`; `MobileGatewayService.kt:314-315` treats only `listening on http://127.0.0.1:8080` log lines as up |
| Health probe is loopback | `MobileGatewayService.kt:321` probes `http://127.0.0.1:8080/health`; `HermesGatewayPlugin.kt:211` probes the same URL natively |
| Client default is loopback | `src/services/gateway.ts:97` defaults `baseUrl` to `http://127.0.0.1:8080` |
| Client refuses remote cleartext | `src/services/gateway.ts:115-118`: `http:` is accepted only for `127.0.0.1`, `localhost`, `::1`; anything else must use `https:` or `setBaseUrl` throws |
| FGS notification states localhost | `MobileGatewayService.kt:102` text `on-phone gateway on localhost:8080` |

Runtime check (on device): `ss -tlnp | grep 8080` (or `cat /proc/net/tcp`)
must show the listener on `7F000001:1F90` (`127.0.0.1:8080`) only, never
`0.0.0.0:8080`. The script's test 6 (LAN IP attempt) is the black-box proof:
a request via the LAN IP must fail to connect.

## 2. Auth rules (expected behavior)

- Local API key (`server_key`) is minted once in
  `android/app/src/main/java/ee/oversight/hermes/mobile/install/Bootstrap.kt:441-445`
  (24 bytes from `SecureRandom`, hex, 48 chars) and stored in the encrypted
  store (`SecurePrefs.KEY_SERVER`, `security/SecurePrefs.kt:28`).
- Fail closed on empty key: `Bootstrap.kt:449-450` throws instead of writing a
  config with an empty key; `HermesGatewayPlugin.kt:181` rejects `serverKey()`
  with `server key not provisioned yet` when blank.
- Secrets are never written unencrypted: `SecurePrefs.kt:131-141` logs and
  keeps the old value on crypto failure instead of falling back to cleartext.
- Client sends `Authorization: Bearer <key>` only when a key exists
  (`src/services/gateway.ts:122-131`) and never sends the key when the gateway
  is unreachable (`gateway.ts:881-885` probes keyless health first in
  `providersValidate`).
- Diagnostics never carry live credentials: `redactSecrets`
  (`src/services/gateway.ts:78-90`) replaces secret fields with `***REDACTED***`.

## 3. CORS allow-list

- Server allow-list: `API_SERVER_CORS_ORIGINS=https://localhost,capacitor://localhost`
  (`MobileGatewayService.kt:269`). Rationale is in `MobileGatewayService.kt:265-268`:
  the WebView app is served from `https://localhost`, so every browser fetch
  preflights and needs an explicit allow-list.
- No other origin may receive an `Access-Control-Allow-Origin` echo.

## 4. Expected results of `scripts/gateway-auth-check.sh`

Run: `HERMES_SERVER_KEY='<key>' bash scripts/gateway-auth-check.sh`
The script never prints the key (masked as first-4 + length) and never uses
`set -x`. Exit 0 means all checks passed.

| # | Request | Want | Why |
|---|---|---|---|
| 1 | `GET /health`, no auth | `HTTP 200` | Keyless liveness signal by design (native `healthOk`, web pre-key probe) |
| 2 | `GET /api/sessions`, no auth | `HTTP 401` or `403` | Protected endpoint, fail closed |
| 3 | `GET /api/sessions`, wrong key | `HTTP 401` or `403` | Wrong key equals no key |
| 4 | `GET /api/sessions`, empty Bearer | `HTTP 401` or `403` | API is never unintentionally open |
| 5 | `GET /api/sessions`, correct key | `HTTP 200` | Happy path |
| 5b | `GET /health/detailed`, correct key | `HTTP 200` | Happy path |
| 6 | `GET http://<LAN-IP>:8080/health`, no auth | connection refused / timeout | Loopback-only bind; reachable-from-LAN is a finding |
| 6b | `GET http://<LAN-IP>:8080/api/sessions`, correct key | connection refused / timeout | Same, even with a valid key |
| 7 | `OPTIONS /api/sessions`, `Origin: https://evil.example` | no `ACAO` echo | Disallowed origin gets nothing |
| 7b | `GET /api/sessions`, `Origin: https://localhost` and `capacitor://localhost` | `ACAO` echoes the origin | Allow-list intact |

Any `CONN_FAILED` on tests 1-5 / 7 means the gateway is down, not a security
result: start it and re-run. A `2xx` on test 6 is the one critical failure
mode (bind not loopback-only).

## 5. Client-side integration spec (no code changes made)

No Kotlin, manifest, or web-source edits were made for this task. Current
client behavior already satisfies the audit; keep these invariants:

1. `GatewayService.setBaseUrl` (`src/services/gateway.ts:103-120`) must keep
   rejecting non-loopback `http:` URLs. Any future custom-URL UI must route
   through it, never assign `baseUrl` directly.
2. `getHeaders` (`gateway.ts:122-131`) must keep omitting `Authorization`
   when the key is empty (fail closed, no `Bearer ` with blank token).
3. `nativeServerKey` (`src/services/nativeGateway.ts:134-143`) returns `''`
   when the bridge is absent; callers must keep treating `''` as
   unauthenticated, never retry with a guessed or empty key.
4. `redactSecrets` (`gateway.ts:78-90`) must keep covering every new secret
   field added to diagnostics or debug-share payloads.
5. If a future WebView origin is added (new scheme/host), update
   `API_SERVER_CORS_ORIGINS` in `MobileGatewayService.kt:269` in the same
   change and re-run test 7 for both the new origin (echo) and an evil
   origin (no echo). Origin allow-list stays explicit, never `*` while
   `Authorization` is in use.

## 6. What was not verified here

- TLS posture for remote (`https:`) base URLs: client code forces `https`
  off-loopback, but no remote endpoint was probed in this task.
- `network_security_config.xml` cleartext scoping (SEC-05 detail): owned by
  T1. Required shape: `cleartextTrafficPermitted=false` by default with a
  loopback-only exception (`127.0.0.1` / `localhost`); remote traffic HTTPS only.
