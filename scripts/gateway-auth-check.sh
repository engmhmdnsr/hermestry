#!/usr/bin/env bash
# Gateway auth + loopback verification matrix (SEC-06).
# Read-only probe: never changes device state, never prints the key.
# Usage:
#   HERMES_SERVER_KEY='<key>' bash scripts/gateway-auth-check.sh
#   bash scripts/gateway-auth-check.sh '<key>'            # arg also accepted
#   BASE_URL=http://127.0.0.1:8080 LAN_IP=192.168.1.50 bash scripts/gateway-auth-check.sh
# On-device (adb): adb shell, then run with BASE_URL=http://127.0.0.1:8080.
set -u
# NOTE: no `set -x`; tracing would leak the key into logs.

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
KEY="${HERMES_SERVER_KEY:-${1:-}}"
LAN_IP="${LAN_IP:-}"
TIMEOUT=5
PASS=0
FAIL=0

mask() { # mask <value> -> first 4 chars + stars, never the full secret
  local v="$1"
  if [ -z "$v" ]; then printf '(empty)'; return; fi
  printf '%s****(%d chars)' "${v:0:4}" "${#v}"
}

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); say "FAIL: $*"; }

# curl wrapper: prints "HTTP <code> [ACAO: <v>] <ms>" to stdout, body discarded.
# Never logs headers (Authorization would leak the key).
req() { # req <method> <url> [auth] [origin]
  local method="$1" url="$2" auth="${3:-}" origin="${4:-}"
  local args=(-s -o /dev/null -w 'HTTP %{http_code} %{time_total}s' --max-time "$TIMEOUT" -X "$method")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  [ -n "$origin" ] && args+=(-H "Origin: $origin")
  if [ "$method" = "OPTIONS" ]; then
    args+=(-H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization,content-type")
  fi
  curl "${args[@]}" "$url" 2>/dev/null || printf 'CONN_FAILED'
}

acao() { # acao <url> [auth] [origin] -> value of access-control-allow-origin or (none)
  local url="$1" auth="${2:-}" origin="${3:-}"
  local args=(-s -D - -o /dev/null --max-time "$TIMEOUT")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  [ -n "$origin" ] && args+=(-H "Origin: $origin")
  curl "${args[@]}" "$url" 2>/dev/null \
    | grep -i '^access-control-allow-origin:' | tr -d '\r' | cut -d' ' -f2- | head -n1 || true
}

expect_code() { # expect_code <label> <actual> <want...>
  local label="$1" actual="$2"; shift 2
  local w
  for w in "$@"; do
    if [ "$actual" = "$w" ]; then ok "$label -> $actual (want one of: $*)"; return; fi
  done
  bad "$label -> $actual (want one of: $*)"
}

say "== Hermes gateway auth matrix =="
say "base: $BASE_URL"
say "key: $(mask "$KEY")"
say ""

if [ -z "$KEY" ]; then
  say "HERMES_SERVER_KEY is empty: correct-auth test becomes an empty-key test (must be rejected)."
  say "Set HERMES_SERVER_KEY (or pass as argv[1]) for the full matrix."
  say ""
fi

# Auto-detect a LAN IP when not given (first non-loopback IPv4).
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -n1 || true)"
  [ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -n1 || true)"
fi
say "lan ip probe target: ${LAN_IP:-(none detected, skipping LAN test)}"
say ""

# 1. Liveness probe without auth. /health is the keyless reachability signal
#    used by the native bridge (HermesGatewayPlugin healthOk) and the web
#    client pre-key probe. Expect 2xx on loopback when the gateway is up.
R="$(req GET "$BASE_URL/health")"
expect_code "1 no-auth GET /health (liveness, keyless by design)" "$R" "HTTP 200 0." "HTTP 200"

# 2. Protected endpoint without auth. Must NOT be 2xx.
R="$(req GET "$BASE_URL/api/sessions?limit=1&offset=0")"
case "$R" in
  "HTTP 401"*|"HTTP 403"*) ok "2 no-auth GET /api/sessions rejected -> $R" ;;
  "CONN_FAILED") bad "2 no-auth GET /api/sessions -> gateway unreachable ($R)" ;;
  *) bad "2 no-auth GET /api/sessions -> $R (want HTTP 401 or HTTP 403)" ;;
esac

# 3. Wrong key. Must be rejected, same as no key.
R="$(req GET "$BASE_URL/api/sessions?limit=1&offset=0" "wrong-key-0000")"
case "$R" in
  "HTTP 401"*|"HTTP 403"*) ok "3 wrong-auth GET /api/sessions rejected -> $R" ;;
  "CONN_FAILED") bad "3 wrong-auth GET /api/sessions -> gateway unreachable ($R)" ;;
  *) bad "3 wrong-auth GET /api/sessions -> $R (want HTTP 401 or HTTP 403)" ;;
esac

# 4. Empty Bearer token. Must be rejected (never an open API).
R="$(req GET "$BASE_URL/api/sessions?limit=1&offset=0" "")"
case "$R" in
  "HTTP 401"*|"HTTP 403"*) ok "4 empty-auth GET /api/sessions rejected -> $R" ;;
  "CONN_FAILED") bad "4 empty-auth GET /api/sessions -> gateway unreachable ($R)" ;;
  *) bad "4 empty-auth GET /api/sessions -> $R (want HTTP 401 or HTTP 403)" ;;
esac

# 5. Correct key. Expect 2xx. Skipped (as a pass) when no key was supplied.
if [ -n "$KEY" ]; then
  R="$(req GET "$BASE_URL/api/sessions?limit=1&offset=0" "$KEY")"
  case "$R" in
    "HTTP 200"*) ok "5 correct-auth GET /api/sessions -> $R" ;;
    "CONN_FAILED") bad "5 correct-auth GET /api/sessions -> gateway unreachable ($R)" ;;
    *) bad "5 correct-auth GET /api/sessions -> $R (want HTTP 200)" ;;
  esac
  R="$(req GET "$BASE_URL/health/detailed" "$KEY")"
  case "$R" in
    "HTTP 200"*) ok "5b correct-auth GET /health/detailed -> $R" ;;
    *) bad "5b correct-auth GET /health/detailed -> $R (want HTTP 200)" ;;
  esac
else
  say "SKIP: 5 correct-auth (no key supplied)"
fi

# 6. LAN-interface attempt. The gateway binds 127.0.0.1 only, so the same
#    request via the LAN IP must fail to connect (or time out), even with a
#    valid key. A 2xx here means the bind is NOT loopback-only: investigate.
if [ -n "$LAN_IP" ]; then
  LAN_URL="http://$LAN_IP:8080"
  R="$(req GET "$LAN_URL/health")"
  case "$R" in
    "CONN_FAILED") ok "6 LAN GET $LAN_URL/health refused (loopback-only bind holds) [$R]" ;;
    *) bad "6 LAN GET $LAN_URL/health -> $R (want CONN_FAILED; reachable from LAN)" ;;
  esac
  if [ -n "$KEY" ]; then
    R="$(req GET "$LAN_URL/api/sessions?limit=1&offset=0" "$KEY")"
    case "$R" in
      "CONN_FAILED") ok "6b LAN correct-auth GET $LAN_URL/api/sessions refused [$R]" ;;
      *) bad "6b LAN correct-auth GET $LAN_URL/api/sessions -> $R (want CONN_FAILED)" ;;
    esac
  fi
else
  say "SKIP: 6 LAN-IP attempt (no LAN IP detected; set LAN_IP= to force)"
fi

# 7. CORS origin matrix. Allow-list is https://localhost + capacitor://localhost.
#    A disallowed Origin must get NO access-control-allow-origin echo (or a
#    4xx on preflight); an allow-listed Origin should get its ACAO echo.
EVIL="https://evil.example"
R="$(req OPTIONS "$BASE_URL/api/sessions" "" "$EVIL")"
A="$(acao "$BASE_URL/api/sessions" "" "$EVIL")"
if [ -z "$A" ]; then
  ok "7 preflight OPTIONS from $EVIL -> $R, no ACAO echo"
else
  bad "7 preflight OPTIONS from $EVIL -> $R, unexpected ACAO: $A"
fi
for GOOD in "https://localhost" "capacitor://localhost"; do
  A="$(acao "$BASE_URL/api/sessions" "" "$GOOD")"
  if [ "$A" = "$GOOD" ] || [ "$A" = "*" ]; then
    ok "7b GET Origin $GOOD -> ACAO: $A"
  else
    bad "7b GET Origin $GOOD -> ACAO: '${A:-(none)}' (want echo of origin)"
  fi
done

say ""
say "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
