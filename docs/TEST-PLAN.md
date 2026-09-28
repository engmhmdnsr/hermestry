# HERMES-MOBILE Test Plan

Executable verification matrix for audit sections 22-24: storage and
migrations, providers and secrets, gateway, sessions, streaming,
attachments, jobs, and the secret-leak sweep. No test runner is bundled,
so each row is runnable as written: `npx tsc --noEmit` for type checks,
`node --input-type=module` snippets for pure logic, and manual device
steps where hardware or the gateway is required.

Type gate (run before every row that touches code):

```sh
npx tsc --noEmit
```

## 1. Storage migrations (`src/services/storageMigrations.ts`)

Source of truth for `migrateSettings`, `MIGRATIONS`, `CURRENT_SCHEMA_VERSION = 3`.
Consumer wiring (HermesContext init) stays as spec until wired; these rows
test the module directly.

| ID | Case | Command / steps | Expect |
|----|------|-----------------|--------|
| STO-01 | v1 payload (no `schemaVersion`) migrates to v3 | node snippet: import `migrateSettings`, pass `{}` | `migratedFrom: 1`, `applied: [2, 3]`, `data.schemaVersion: 3` |
| STO-02 | deepseek seed cleanup | pass `{ providers: [{ id: 'prov_deepseek_default', provider: 'deepseek', name: 'DeepSeek', apiKey: '', defaultModel: 'x', enabled: true }] }` | seed entry removed; real keyed deepseek entries kept |
| STO-03 | dead active-provider selection cleared | pass `{ provider: 'deepseek', modelId: 'm', providers: [] }` | `provider` and `modelId` reset to `''` |
| STO-04 | legacy flat pair folds into list | pass `{ provider: 'custom', apiKey: 'k', baseUrl: 'u', modelId: 'm' }` | one entry `prov_custom`, `validated: true`, no seed entries |
| STO-05 | opencode-go placeholder mapping | pass `{ schemaVersion: 2, provider: 'opencode-go', modelId: 'opencode-go/foo', providers: [{ id: 'p1', provider: 'opencode-go', name: 'n', apiKey: 'k', defaultModel: 'opencode-go/foo', enabled: true }] }` | `modelId` and `defaultModel` become `deepseek-v4.1-flash` |
| STO-06 | already-current payload is a no-op | pass `{ schemaVersion: 3, providers: [] }` | `applied: []`, `migratedFrom: 3` |
| STO-07 | corrupt payload returns null | `loadMigratedSettings` with `getItem` returning `'{{{'` | returns `null`, no throw |
| STO-08 | missing payload returns null | `loadMigratedSettings` with `getItem` returning `null` | returns `null` |
| STO-09 | write-back persists migrated copy | `loadMigratedSettings(store, persist)` on a v1 payload | `persist` called once with JSON containing `schemaVersion: 3` |
| STO-10 | no ad hoc mutation at init | `grep -rn schemaVersion src/context/` | only reads; all writes flow through `MIGRATIONS` |

## 2. Provider CRUD (`src/context/HermesContext.tsx`, `src/constants/providers.ts`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| PRV-01 | add provider | Settings > providers > add (type `openai-api`, key `k`, model `gpt-4o`) | new id `prov_*`, appears enabled, active switches |
| PRV-02 | update provider | edit key/baseUrl on one entry | only that id changes, others untouched, persists after reload |
| PRV-03 | remove provider | delete active entry | selection falls to another entry or empty, no dead `provider`/`modelId` |
| PRV-04 | alias normalization | `normProvider('claude-code')`, `('go')`, `('lm-studio')` via node snippet | `anthropic`, `opencode-go`, `lmstudio` |
| PRV-05 | keyless providers need no key | `keysValid('lmstudio', '', '')` | `true`; unknown slug without baseUrl is `false` |

## 3. Secret separation and vault (`src/services/secureStore.ts`, `src/context/HermesContext.tsx`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| SEC-01 | encrypt/decrypt round trip | `vaultEncryptSecrets(pin, secrets)` then `vaultDecryptSecrets(pin, blob)` | identical secrets back |
| SEC-02 | wrong PIN fails | decrypt with different PIN | throws/returns failure, no partial secrets |
| SEC-03 | lock clears memory | unlock, then `lockSecrets()` / `lockNow()` | in-memory refs cleared; `localStorage hermes_settings` holds ciphertext only |
| SEC-04 | locked at rest | enable AppLock, reload page, inspect `localStorage hermes_settings` | `apiKey`, `serverKey`, `tgToken`, `discordToken`, `appLockPin` are `''` |
| SEC-05 | corrupt vault blob | store garbage in `hermes_vault`, attempt unlock | clean failure state, app stays usable, no crash |
| SEC-06 | no-vault legacy path | no `hermes_vault` key, AppLock off | previous session-unlock behavior, no PIN gate |

## 4. PIN and lock gate (`src/components/security/AppLockGate.tsx`, `src/App.tsx`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| PIN-01 | correct PIN unlocks | set AppLock PIN, reload, enter PIN | gate clears, session continues |
| PIN-02 | wrong PIN rejected | enter wrong PIN 3 times | stays locked, no hint of correct PIN |
| PIN-03 | background relock | unlock, enable AppLock, trigger vault relock | `isUnlocked` drops, PIN gate shows again |

## 5. Gateway (`src/services/gateway.ts`, `src/services/nativeGateway.ts`)

Manual rows need the on-device APK or `vite` dev plus a loopback gateway.

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| GW-01 | start/stop | `startGateway()` then stop via context | `connected` true then false, install state sane |
| GW-02 | auth (server key) | set wrong `serverKey`, call `healthDetailed()` | auth failure surfaced, `gatewayFailed` with reason |
| GW-03 | loopback only | confirm base URL host | `127.0.0.1` only, no LAN/wildcard bind |
| GW-04 | CORS | browser fetch from foreign origin to `:8080` | rejected; first-party app origin works |
| GW-05 | start timeout | gateway not reachable, `startGateway()` on native | polls then fails with `not reachable after 4 minutes` hint, `install: FAILED` |
| GW-06 | port conflict | occupy `:8080`, start gateway | clear failure reason, no silent attach to foreign server |
| GW-07 | first-boot poll | fresh native start | `Still waiting for gateway...` logs, success path calls `refreshNow()` |

## 6. Sessions (`src/services/gateway.ts`, `src/context/HermesContext.tsx`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| SES-01 | pagination | seed >1 page of sessions, scroll list | next page loads, no dupes, order stable |
| SES-02 | offline create | airplane mode, new chat + send | local `sess_*` persists via `saveLocalSessions` |
| SES-03 | reconcile on reconnect | reconnect with server list missing local ids | local-only sessions merged, not clobbered |
| SES-04 | select/rename/delete/fork | each action via context | list and `loadLocalMessages` stay consistent |

## 7. Streaming SSE edge cases (`src/context/HermesContext.tsx`, `src/services/gateway.ts`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| SSE-01 | mid-stream abort | send, then `stopStream()` | bubble marked stopped, `thinkingDone`, no hang |
| SSE-02 | gateway error mid-stream | kill gateway mid-turn | `Stream error: ...` bubble, log line, `streaming` false |
| SSE-03 | retry strips dead bubbles | retry after `Stream error:` bubble | no duplicate empty hermes bubbles accumulate |
| SSE-04 | send during stream queues | send while `streamingRef` true | queued, `Stream busy, message queued` log, sent next turn |
| SSE-05 | approval gating | trigger approval with `autoApproveGlobal` off, then on | off: approval queued; on: auto-resolved with scope |
| SSE-06 | usage fallback | stream with no usage events | estimated tokens from text length, totals nonzero |

## 8. Attachments (`src/components/tabs/ChatTab.tsx`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| ATT-01 | image cap | attach 5 images | capped at 4, counter shows `n/4 attached` |
| ATT-02 | text file truncation | attach >20000-char text file | inlined with `[truncated]` marker at `MAX_TEXT_FILE_CHARS` |
| ATT-03 | empty send blocked | send with no text and no attachments | returns false, nothing queued |
| ATT-04 | speech truncation | long reply via speech path | capped at `MAX_SPEECH_CHARS` (1500) |

## 9. Jobs and timezone (`src/components/tabs/JobsTab.tsx`, `src/context/HermesContext.tsx`)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| JOB-01 | create valid | name + `0 9 * * *` + prompt | `createJob` true, appears in list |
| JOB-02 | reject bad schedule | schedule `nope` | inline error, gateway never called |
| JOB-03 | update schedule | edit `scheduleDisplay` to new cron | persists, next run reflects change |
| JOB-04 | enable/disable + delete | `jobAction` each | state flips, delete removes |
| JOB-05 | runs history | `fetchRuns(jobId)` | runs listed per job, errors surfaced |
| JOB-06 | timezone sanity | create `0 9 * * *`, check `nextRunAt` vs device tz | fires 09:00 device-local, no UTC shift surprise |

## 10. Secret-leak matrix

Run after every change touching settings, logs, exports, or network.

| ID | Surface | Check | Expect |
|----|---------|-------|--------|
| LEAK-01 | `localStorage hermes_settings` with AppLock on | read raw value | no `apiKey`, `serverKey`, `tgToken`, `discordToken`, `appLockPin` |
| LEAK-02 | gateway logs (`gatewayLogs`) | trigger failures, read log panel | no keys, PINs, or tokens in any line |
| LEAK-03 | debug share bundle | generate bundle in Settings > Diagnostics | URLs redacted, summary has no secrets |
| LEAK-04 | chat content | send key-like string, inspect persisted messages | user text intact locally, never forwarded to unrelated provider |
| LEAK-05 | console output | devtools console during unlock/stream | no secret dumps |
| LEAK-06 | static grep | `grep -rni "sk-\|apiKey.*726\|pin.*1234" src/ --include="*.ts*"` | only test fixtures and redaction code match |

## 11. Perf smoke (PERF-01)

| ID | Case | Steps | Expect |
|----|------|-------|--------|
| PERF-01a | lazy Jobs/Settings chunks | `npx vite build --mode development` or open Network tab, visit Jobs and Settings tabs | separate chunks load on demand; initial bundle excludes `SettingsTab`/`JobsTab` |
| PERF-01b | tab fallback | throttle network to Slow 3G, tap Settings | spinner fallback shows, no blank crash |
