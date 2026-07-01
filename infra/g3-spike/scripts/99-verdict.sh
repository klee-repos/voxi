#!/usr/bin/env bash
# G3 verdict — aggregate the recorded step outcomes in out/ and emit the HARD go/no-go.
# Reads ONLY what the step scripts actually recorded (out/C0..C4.json); it does not re-run or infer anything.
# G3: PASS iff C0,C1,C2,C3,C4 are all "pass". Otherwise NO-GO -> §4.5 fallback fires; §20.2 stays blocked.
# Portable to bash 3.2 (macOS default): no associative arrays.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

verdict_of() { # verdict_of <step-id> -> echoes pass|fail|missing
  local f="${OUT_DIR}/$1.json"
  [ -f "$f" ] || { echo missing; return; }
  grep -oE '"verdict"[[:space:]]*:[[:space:]]*"[a-z]+"' "$f" | grep -oE '(pass|fail)' || echo missing
}

ALL_PASS=1
V_C0="$(verdict_of C0)"; V_C1="$(verdict_of C1)"; V_C2="$(verdict_of C2)"
V_C3="$(verdict_of C3)"; V_C4="$(verdict_of C4)"
for v in "$V_C0" "$V_C1" "$V_C2" "$V_C3" "$V_C4"; do
  [ "$v" = pass ] || ALL_PASS=0
done
printf '  %-3s %s\n' C0 "$V_C0" C1 "$V_C1" C2 "$V_C2" C3 "$V_C3" C4 "$V_C4"

C3_MODE="$(grep -oE '"C3_mode"[[:space:]]*:[[:space:]]*"[a-z]+"' "${OUT_DIR}/C3.json" 2>/dev/null | grep -oE '(completes|impossible)' || echo unknown)"

{
  echo '{'
  echo "  \"gate\": \"G3\","
  echo "  \"recordedAt\": \"$(date -u +%FT%TZ)\","
  echo "  \"C0_boot\": \"${V_C0}\","
  echo "  \"C1_resume\": \"${V_C1}\","
  echo "  \"C2_skiplocked\": \"${V_C2}\","
  echo "  \"C3_selfcall\": \"${V_C3}\","
  echo "  \"C3_mode\": \"${C3_MODE}\","
  echo "  \"C4_pin\": \"${V_C4}\","
  echo "  \"verdict\": \"$( [ $ALL_PASS -eq 1 ] && echo PASS || echo NO-GO )\""
  echo '}'
} > "${OUT_DIR}/result.json"

echo
if [ $ALL_PASS -eq 1 ]; then
  ok "G3: PASS — eve self-hosts durably off Vercel. §20.2 backend feature work is UNBLOCKED."
  echo "      C3 mode='${C3_MODE}' (impossible => checkpoint-everything is a hard turn-design constraint)."
  exit 0
else
  fail "G3: NO-GO — one or more checks did not PASS. The §4.5 fallback fires; §20.2 stays BLOCKED."
  echo "      result -> ${OUT_DIR}/result.json"
  exit 1
fi
