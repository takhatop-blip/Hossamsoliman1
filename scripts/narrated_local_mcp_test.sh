#!/usr/bin/env bash
# اختبار E2E محلي كامل لأداة generate_narrated_video (مطابق لمسار الإنتاج)
# initialize → initialized → tools/list → tools/call generate_narrated_video → get_task
set -e
BASE="${1:-http://127.0.0.1:3000/mcp}"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
SESSION=""

mcp_post() {
  local body="$1"
  if [ -n "$SESSION" ]; then
    curl -s --max-time 300 -D /tmp/mcp_headers_local.txt -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$body" "$BASE"
  else
    curl -s --max-time 300 -D /tmp/mcp_headers_local.txt "${HDRS[@]}" -d "$body" "$BASE"
  fi
}

echo "== 1) initialize =="
mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"local-e2e","version":"1.0"}}}' | head -c 220; echo
SESSION=$(grep -i '^mcp-session-id:' /tmp/mcp_headers_local.txt | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"

echo "== 2) initialized =="
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
echo ok

echo "== 3) tools/list =="
R=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$R" | grep -o 'generate_narrated_video' | head -1 || echo "TOOL_MISSING"

echo "== 4) tools/call generate_narrated_video (صورة جاهزة + راوي عربي قصير) =="
START=$(date +%s)
R=$(mcp_post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_narrated_video","arguments":{"images":["https://picsum.photos/id/1024/1280/720.jpg"],"narration_text":"في قلب الغابة الخضراء كان الأسد الصغير يبحث عن صديق يلعب معه كل يوم.","voice_lang":"ar","resolution":"480p","aspect_ratio":"16:9","wait_seconds":150}}}')
END=$(date +%s)
echo "duration: $((END-START))s"
echo "$R" | sed 's/\\n/\n/g' | head -c 1800
echo
