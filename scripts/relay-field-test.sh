#!/usr/bin/env bash
# =============================================================================
# Nexus Relay — Android Field Test
# =============================================================================
# Simulates the exact HTTP traffic the Android Relay app running on the MODEL's
# phone sends to the Nexus Hub backend.
#
# Architecture:
#   • Relay app is installed on the MODEL's phone.
#   • It authenticates using installationId + a per-device HMAC secret
#     HMAC-SHA256(DEVICE_SECRET, installationId) — no Bearer token.
#   • A Senior Operator / Manager token is only used to verify that messages
#     were actually persisted in the database (read-only).
#
# Usage:
#   ./scripts/relay-field-test.sh
#
# Required env vars (or set in .env):
#   API_BASE_URL              e.g. https://nexus-api.myvnc.com/api
#   DEVICE_SECRET             shared relay secret (NEXUS_DEVICE_SECRET on server)
#   RELAY_INSTALLATION_ID     installationId of the relay phone
#   RELAY_PROFILE_ID          profile the phone is bound to (e.g. ldn-01)
#
# Optional:
#   CALLER_PHONE              simulated inbound caller (default: +420777000099)
#   # For DB persistence check (read-only, optional):
#   RELAY_CHECKER_EMAIL       operator/manager login to verify DB persistence
#   RELAY_CHECKER_PASSWORD
#   FIELD_TEST_STRICT         "true" to exit 1 on any failure (default: true)
# =============================================================================

set -euo pipefail

# ─── Load .env if present ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -o allexport; source "$ENV_FILE"; set +o allexport
fi

# ─── Config ──────────────────────────────────────────────────────────────────
API_BASE="${API_BASE_URL:-https://nexus-api.myvnc.com/api}"
API_BASE="${API_BASE%/}"

DEVICE_SECRET="${DEVICE_SECRET:-}"
INSTALLATION_ID="${RELAY_INSTALLATION_ID:-}"
PROFILE_ID="${RELAY_PROFILE_ID:-}"
# Per-device relay secret = HMAC-SHA256(DEVICE_SECRET, installationId) — matches the
# server deriveRelaySecret(). The raw global DEVICE_SECRET is no longer accepted in
# production; the relay authenticates per-device.
RELAY_SECRET=""
if [ -n "$DEVICE_SECRET" ] && [ -n "$INSTALLATION_ID" ]; then
  RELAY_SECRET=$(printf '%s' "$INSTALLATION_ID" | openssl dgst -sha256 -hmac "$DEVICE_SECRET" | awk '{print $NF}')
fi
CALLER_PHONE="${CALLER_PHONE:-+420777000099}"
STRICT="${FIELD_TEST_STRICT:-true}"

# Optional: operator credentials only for DB persistence check (read-only)
CHECKER_EMAIL="${RELAY_CHECKER_EMAIL:-}"
CHECKER_PASSWORD="${RELAY_CHECKER_PASSWORD:-}"

RUN_ID="field-$(date +%s)"

# ─── Colors & counters ───────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
PASS=0; SKIP=0; FAIL=0

ok()   { echo -e "  ${GREEN}✔ PASS${RESET}  $1"; PASS=$((PASS+1)); }
skip() { echo -e "  ${YELLOW}⏭ SKIP${RESET}  $1"; SKIP=$((SKIP+1)); }
fail() { echo -e "  ${RED}✘ FAIL${RESET}  $1"; FAIL=$((FAIL+1)); }
info() { echo -e "\n${BOLD}▶ $1${RESET}"; }

# ─── HTTP helpers ─────────────────────────────────────────────────────────────
HTTP_STATUS=""
BODY=""

curl_call() {
  local tmpfile
  tmpfile=$(mktemp)
  HTTP_STATUS=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 20 "$@" 2>/dev/null)
  BODY=$(cat "$tmpfile")
  rm -f "$tmpfile"
}

check_status() {
  local label="$1" expected="$2"
  if [ "$HTTP_STATUS" = "$expected" ]; then
    ok "$label (HTTP $HTTP_STATUS)"
  else
    fail "$label — expected HTTP $expected, got HTTP $HTTP_STATUS"
    echo "       Body: ${BODY:0:300}"
  fi
}

check_body_contains() {
  local label="$1" expected_status="$2" needle="$3"
  if [ "$HTTP_STATUS" = "$expected_status" ] && echo "$BODY" | grep -qF "$needle"; then
    ok "$label (HTTP $HTTP_STATUS)"
  else
    fail "$label — HTTP $HTTP_STATUS, body missing '$needle'"
    echo "       Body: ${BODY:0:300}"
  fi
}

# =============================================================================
# Preflight
# =============================================================================
info "Preflight — relay phone credentials"
missing=0
for var in API_BASE DEVICE_SECRET INSTALLATION_ID PROFILE_ID; do
  val="${!var:-}"
  if [ -z "$val" ]; then
    echo "  ✗ Missing: $var"
    missing=$((missing+1))
  else
    case "$var" in
      # Přihlašovací tajemství do logu nepatří ani zkrácené. GitHub Actions
      # maskují PŘESNOU hodnotu secretu, takže 50znakový prefix delšího klíče
      # té masce unikne — a při lokálním spuštění se nemaskuje nic. Pro
      # diagnostiku stačí, že je proměnná vyplněná, a její délka.
      #
      # Vzorek místo výčtu, aby nová tajná proměnná v seznamu výš nevypadla
      # do logu jen proto, že si na ni někdo nevzpomněl.
      *SECRET*|*PASSWORD*|*TOKEN*)
        echo "  ✓ $var je nastaveno (${#val} znaků)" ;;
      *)
        echo "  ✓ $var = ${val:0:50}$([ ${#val} -gt 50 ] && echo '...' || true)" ;;
    esac
  fi
done
if [ "$missing" -gt 0 ]; then
  echo -e "\n${RED}Set missing variables and retry.${RESET}"
  exit 1
fi

if [ -n "$CHECKER_EMAIL" ]; then
  echo "  ✓ RELAY_CHECKER_EMAIL configured — DB persistence check enabled"
else
  echo "  ⚠  RELAY_CHECKER_EMAIL not set — DB persistence check will be skipped"
fi

# =============================================================================
# [1] Public health — server is up at all
# =============================================================================
info "[1] Server health → GET /health"
curl_call -X GET "${API_BASE}/health"
check_status "[1] Server health" "200"

# =============================================================================
# [2] Relay inbound SMS — exact payload Android Relay app sends
#     No Bearer token — only installationId + DEVICE_SECRET
# =============================================================================
info "[2] Relay inbound SMS → POST /device/relay  (model phone, no auth header)"
SMS_CONTENT="FieldTest inbound ${RUN_ID}"
curl_call -X POST "${API_BASE}/device/relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"installationId\": \"${INSTALLATION_ID}\",
    \"deviceId\": \"RELAY-DEVICE\",
    \"type\": \"sms\",
    \"transport\": \"sms\",
    \"from\": \"${CALLER_PHONE}\",
    \"content\": \"${SMS_CONTENT}\",
    \"secret\": \"${RELAY_SECRET}\",
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
  }"
check_body_contains "[2] Relay inbound SMS accepted" "200" '"ok":true'

# =============================================================================
# [3] Czech phone number variant smoke
#     Android pre-processes numbers in various formats — all must be accepted
# =============================================================================
info "[3] Number variant smoke — Czech formats (+420 / 420 / 0 / local)"
CALLER_DIGITS=$(echo "$CALLER_PHONE" | tr -cd '0-9')
if [[ "${CALLER_DIGITS}" == 420* ]] && [ "${#CALLER_DIGITS}" -gt 9 ]; then
  NATIONAL="${CALLER_DIGITS#420}"
  VARIANTS=("+420${NATIONAL}" "420${NATIONAL}" "0${NATIONAL}" "${NATIONAL}")
else
  VARIANTS=("${CALLER_PHONE}")
fi

for variant in "${VARIANTS[@]}"; do
  curl_call -X POST "${API_BASE}/device/relay" \
    -H "Content-Type: application/json" \
    -d "{
      \"installationId\": \"${INSTALLATION_ID}\",
      \"deviceId\": \"RELAY-DEVICE\",
      \"type\": \"sms\",
      \"transport\": \"sms\",
      \"from\": \"${variant}\",
      \"content\": \"Variant test ${variant} ${RUN_ID}\",
      \"secret\": \"${RELAY_SECRET}\"
    }"
  check_body_contains "[3] Number variant ${variant}" "200" '"ok":true'
done

# =============================================================================
# [4] Relay call RINGING event
# =============================================================================
info "[4] Relay call RINGING → POST /device/relay"
curl_call -X POST "${API_BASE}/device/relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"installationId\": \"${INSTALLATION_ID}\",
    \"deviceId\": \"RELAY-DEVICE\",
    \"type\": \"call\",
    \"transport\": \"call\",
    \"from\": \"${CALLER_PHONE}\",
    \"content\": \"RINGING\",
    \"secret\": \"${RELAY_SECRET}\"
  }"
check_body_contains "[4] Relay RINGING accepted" "200" '"ok":true'

# =============================================================================
# [5] Security: wrong secret must be rejected with 401
# =============================================================================
info "[5] Wrong secret rejection → POST /device/relay"
curl_call -X POST "${API_BASE}/device/relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"installationId\": \"${INSTALLATION_ID}\",
    \"type\": \"sms\",
    \"transport\": \"sms\",
    \"from\": \"${CALLER_PHONE}\",
    \"content\": \"Should be rejected\",
    \"secret\": \"WRONG_SECRET_12345\"
  }"
check_status "[5] Wrong secret → 401" "401"

# =============================================================================
# [6] Security: explicit mismatched userId must be rejected with 401
# =============================================================================
info "[6] Mismatched userId rejection → POST /device/relay"
curl_call -X POST "${API_BASE}/device/relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"installationId\": \"${INSTALLATION_ID}\",
    \"userId\": \"wrong-user-id-12345\",
    \"type\": \"sms\",
    \"transport\": \"sms\",
    \"from\": \"${CALLER_PHONE}\",
    \"content\": \"Should be rejected\",
    \"secret\": \"${RELAY_SECRET}\"
  }"
check_status "[6] Mismatched userId → 401" "401"

# =============================================================================
# [7] Outbox poll — relay app polls for queued outbound messages
#     Also unauthenticated from relay side (uses installationId + profileId)
# =============================================================================
info "[7] Outbox poll → GET /messages/outbox"
curl_call -X GET "${API_BASE}/messages/outbox?profileId=${PROFILE_ID}&installationId=${INSTALLATION_ID}"
# 200 = outbox works; 401 = outbox requires auth (backend decision)
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  ok "[7] Outbox endpoint reachable (HTTP $HTTP_STATUS)"
  if [ "$HTTP_STATUS" = "200" ]; then
    OUTBOX_COUNT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "?")
    echo "       Pending outbox messages: ${OUTBOX_COUNT}"
  fi
else
  fail "[7] Outbox endpoint returned unexpected HTTP $HTTP_STATUS"
  echo "       Body: ${BODY:0:200}"
fi

# =============================================================================
# [8] DB persistence check (optional — needs operator/manager read access)
#     This step is NOT part of the relay app flow — it's a verification step
#     to confirm that the message from step [2] actually landed in the DB.
# =============================================================================
info "[8] DB persistence check (operator read-only)"
if [ -z "$CHECKER_EMAIL" ] || [ -z "$CHECKER_PASSWORD" ]; then
  skip "[8] DB persistence check — RELAY_CHECKER_EMAIL / RELAY_CHECKER_PASSWORD not set"
else
  # Login as operator (read-only access to chats/messages)
  curl_call -X POST "${API_BASE}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${CHECKER_EMAIL}\",\"password\":\"${CHECKER_PASSWORD}\"}"

  if [ "$HTTP_STATUS" = "200" ] && echo "$BODY" | grep -qF '"token"'; then
    CHECKER_TOKEN=$(echo "$BODY" | grep -oP '"token"\s*:\s*"\K[^"]+' | head -1)
    ok "[8a] Operator login OK"

    # Fetch chats and find the one for CALLER_PHONE
    curl_call -X GET "${API_BASE}/chats" -H "Authorization: Bearer ${CHECKER_TOKEN}"
    if [ "$HTTP_STATUS" = "200" ]; then
      CALLER_DIGITS=$(echo "$CALLER_PHONE" | tr -cd '0-9')
      CHAT_ID=$(echo "$BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
digits = '${CALLER_DIGITS}'
for c in data:
  eid = (c.get('externalId') or '').replace(' ','').replace('+','').replace('-','')
  if digits in eid or digits[-9:] in eid:
    print(c.get('id',''))
    break
" 2>/dev/null || true)

      if [ -n "$CHAT_ID" ]; then
        ok "[8b] Chat found for ${CALLER_PHONE} (chatId=${CHAT_ID})"
        curl_call -X GET "${API_BASE}/messages/${CHAT_ID}" -H "Authorization: Bearer ${CHECKER_TOKEN}"
        if [ "$HTTP_STATUS" = "200" ] && echo "$BODY" | grep -qF "$SMS_CONTENT"; then
          ok "[8c] Message from step [2] persisted in DB ✓"
        else
          fail "[8c] Message NOT found in DB"
          echo "       Body (first 400): ${BODY:0:400}"
        fi
      else
        fail "[8b] Chat NOT found for ${CALLER_PHONE} in DB"
        echo "       Chats body (first 300): ${BODY:0:300}"
      fi
    else
      fail "[8a] GET /chats failed — HTTP $HTTP_STATUS"
    fi
  else
    fail "[8a] Operator login failed — HTTP $HTTP_STATUS"
  fi
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo -e "${BOLD} Relay Field Test — Summary${RESET}"
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}PASSED:${RESET}  ${PASS}"
echo -e "  ${YELLOW}SKIPPED:${RESET} ${SKIP}"
echo -e "  ${RED}FAILED:${RESET}  ${FAIL}"
echo -e "  TOTAL:   $((PASS + SKIP + FAIL))"
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo ""

if [ "${STRICT}" = "true" ] && [ "${FAIL}" -gt 0 ]; then
  echo -e "${RED}Field test failed (${FAIL} failure(s)). Exit 1.${RESET}"
  exit 1
fi

echo -e "${GREEN}Field test completed.${RESET}"
exit 0
