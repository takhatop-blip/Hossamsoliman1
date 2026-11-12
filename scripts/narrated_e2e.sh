#!/usr/bin/env bash
# اختبار E2E حي كامل لأداة generate_narrated_video عبر MCP المنشور
# صور روابط مباشرة (Pollinations) + نص تعليق عربي → فيديو بصوت راوٍ
set -e
BASE="https://hossamsoliman1.vercel.app/mcp"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
SESSION=""

mcp_post() {
  local body="$1"
  if [ -n "$SESSION" ]; then
    curl -s --max-time 300 -D /tmp/mcp_headers.txt -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$body" "$BASE"
  else
    curl -s --max-time 300 -D /tmp/mcp_headers.txt "${HDRS[@]}" -d "$body" "$BASE"
  fi
}

text_of() {
  # استخراج حقل text من استجابة JSON-RPC (يدعم SSE و JSON الخام)
  python3 -c '
import sys, json, re
raw = sys.stdin.read()
m = re.search(r"data: (.*)", raw)
payload = m.group(1) if m else raw
try:
    j = json.loads(payload)
    c = j.get("result", {}).get("content", [])
    print(c[0].get("text", "") if c else json.dumps(j, ensure_ascii=False)[:800])
    err = j.get("result", {}).get("isError", False)
    print("isError:", err, file=sys.stderr)
except Exception as e:
    print("PARSE_FAIL:", raw[:800])
'
}

echo "== 1) initialize =="
mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e-narrated","version":"1.0"}}}' | head -c 300; echo
SESSION=$(grep -i '^mcp-session-id:' /tmp/mcp_headers.txt | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"

echo "== 2) notifications/initialized =="
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null && echo ok

echo "== 3) tools/call generate_narrated_video =="
IMG1="https://image.pollinations.ai/prompt/lion%20cub%20in%20green%20forest%20morning%20light?width=1280&height=720&nologo=true&seed=42"
IMG2="https://image.pollinations.ai/prompt/cute%20white%20rabbit%20in%20meadow%20flowers?width=1280&height=720&nologo=true&seed=77"
NARR='في قلب الغابة الخضراء، كان الأسد الصغير يبحث عن صديق يلعب معه. وفي يوم من الأيام، وجد أرنبًا لطيفًا بين الزهور، فصارا صديقين لا يفترقان.'
BODY=$(python3 - "$IMG1" "$IMG2" "$NARR" <<'PY'
import json, sys
img1, img2, narr = sys.argv[1], sys.argv[2], sys.argv[3]
args = {
    "images": [img1, img2],
    "narration_text": narr,
    "voice_lang": "ar",
    "resolution": "480p",
    "aspect_ratio": "16:9",
    "wait_seconds": 60,
}
print(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_narrated_video","arguments":args}}))
PY
)
START=$(date +%s)
R=$(mcp_post "$BODY")
END=$(date +%s)
echo "duration: $((END-START))s"
RESP_TEXT=$(echo "$R" | text_of 2>/tmp/iserr.txt)
cat /tmp/iserr.txt
echo "$RESP_TEXT"
TASK_ID=$(echo "$RESP_TEXT" | grep -o 'task_id: [a-f0-9-]*' | head -1 | cut -d' ' -f2)
echo "TASK_ID: $TASK_ID"

if [ -n "$TASK_ID" ]; then
  echo "== 4) get_task polling =="
  for i in $(seq 1 40); do
    sleep 12
    R=$(mcp_post "{\"jsonrpc\":\"2.0\",\"id\":$((i+2)),\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}")
    T=$(echo "$R" | text_of 2>/dev/null)
    echo "--- poll $i ($(date +%H:%M:%S)): $(echo "$T" | head -c 220)"
    if echo "$T" | grep -q "✅"; then echo "DONE"; echo "$T"; break; fi
    if echo "$T" | grep -q "❌"; then echo "FAILED"; echo "$T"; break; fi
  done
fi
