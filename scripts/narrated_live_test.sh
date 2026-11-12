#!/usr/bin/env bash
# اختبار E2E حي لأداة generate_narrated_video على خادم MCP المنشور
# initialize → initialized → tools/call generate_narrated_video (صورة رابط جاهز + نص راوي قصير)
set -e
BASE="https://hossamsoliman1.vercel.app/mcp"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
SESSION=""

mcp_post() {
  local body="$1"
  if [ -n "$SESSION" ]; then
    curl -s --max-time 240 -D /tmp/mcp_headers.txt -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$body" "$BASE"
  else
    curl -s --max-time 240 -D /tmp/mcp_headers.txt "${HDRS[@]}" -d "$body" "$BASE"
  fi
}

echo "== 1) initialize =="
R=$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e-narrated","version":"1.0"}}}')
echo "$R" | head -c 300; echo
SESSION=$(grep -i '^mcp-session-id:' /tmp/mcp_headers.txt | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"

echo "== 2) notifications/initialized =="
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
echo "ok"

echo "== 3) tools/list — هل الأداة مسجلة؟ =="
R=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$R" | grep -o 'generate_narrated_video' | head -1 || echo "TOOL_MISSING"

echo "== 4) tools/call generate_narrated_video =="
START=$(date +%s)
R=$(mcp_post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_narrated_video","arguments":{"images":["https://picsum.photos/id/1024/1280/720.jpg"],"narration_text":"في قلب الغابة الخضراء كان الأسد الصغير يبحث عن صديق يلعب معه.","voice_lang":"ar","resolution":"480p","aspect_ratio":"16:9","wait_seconds":180}}}')
END=$(date +%s)
echo "duration: $((END-START))s"
echo "$R" | sed 's/\\n/\n/g' | head -c 2000
echo
