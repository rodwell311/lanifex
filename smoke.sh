#!/usr/bin/env bash
# Smoke test end-to-end PlanForge: web wizard → PRD → fitur/task → token agent → loop CLI.
# Pakai MOCK_LLM=1 (deterministik, tanpa provider). Jalankan: bash smoke.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8799}"
DATA_DIR="$(mktemp -d)"
BASE="http://127.0.0.1:$PORT"
JAR="$(mktemp)"
export PORT DATA_DIR
# NB: jangan sentuh ./data milik container Docker — smoke test pakai DATA_DIR sendiri.

MOCK_LLM=1 node server.js &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

for i in $(seq 1 30); do curl -sf "$BASE/api/me" -c "$JAR" >/dev/null 2>&1 && break; sleep 0.5; done

say() { printf '\n=== %s ===\n' "$1"; }
J() { curl -s -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

say "register"
J -X POST "$BASE/api/auth/register" -d '{"email":"smoke@test.dev","password":"secret123"}'

say "questions"
Q=$(J -X POST "$BASE/api/plan/questions" -d '{"idea":"aplikasi pencatat pengeluaran harian","language":"id"}')
echo "$Q" | head -c 300; echo
test "$(echo "$Q" | grep -c 'target-user')" -ge 1 || { echo "FAIL: questions"; exit 1; }

say "create plan"
PLAN=$(J -X POST "$BASE/api/plan/create" -d "{\"idea\":\"aplikasi pencatat pengeluaran harian\",\"tech\":{\"frontend\":\"Next.js\"},\"questions\":$Q,\"answers\":{\"target-user\":\"pekerja kantor\"}}")
PID=$(echo "$PLAN" | sed -E 's/.*"planId":([0-9]+).*/\1/')
echo "planId=$PID"; test "$PID" -ge 1 || { echo "FAIL: create"; exit 1; }

say "generate PRD (stream)"
J -X POST "$BASE/api/plan/$PID/generate" | head -c 300; echo
J "$BASE/api/plan/$PID" | grep -q '"prd"' || { echo "FAIL: prd"; exit 1; }

say "features + tasks"
J -X POST "$BASE/api/plan/$PID/features" >/dev/null
TOTAL=$(J "$BASE/api/plan/$PID/progress" | sed -E 's/.*"total":([0-9]+).*/\1/')
echo "total tasks=$TOTAL"; test "$TOTAL" -ge 4 || { echo "FAIL: tasks"; exit 1; }

say "agent token + prompt"
TOK=$(J -X POST "$BASE/api/plan/$PID/agent-token" | sed -E 's/.*"token":"([^"]+)".*/\1/')
echo "token=${TOK:0:14}..."
J "$BASE/api/agent/status" -H "authorization: Bearer $TOK" | grep -q '"ok":true' || { echo "FAIL: token"; exit 1; }

say "CLI loop"
export PLANFORGE_TOKEN="$TOK"
node cli.js login --server "$BASE" --token "$TOK"
node cli.js plan get "$PID" | head -3
REF=$(node cli.js task next --plan "$PID" --json | sed -E 's/.*"ref":"([^"]+)".*/\1/')
echo "next=$REF"
node cli.js task start "$REF"
node cli.js task complete "$REF"
PROG=$(J "$BASE/api/plan/$PID/progress")
echo "progress after 1 task: $PROG"
echo "$PROG" | grep -q '"done":1' || { echo "FAIL: progress"; exit 1; }

say "checkpoint metadata (layer/phase dari server)"
node cli.js task next --plan "$PID" --json

say "PASS — smoke test OK"
