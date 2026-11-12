#!/usr/bin/env bash
# اختبار E2E كامل عبر MCP: initialize → initialized → tools/call generate_image
set -e
BASE="https://hossamsoliman1.vercel.app/mcp"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
SESSION=""

mcp_post() {
  local body="$1"
  if [ -n "$SESSION" ]; then
    curl -s --max-time 180 -D /tmp/mcp_headers.txt -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$body" "$BASE"
  else
    curl -s --max-time 180 -D /tmp/mcp_headers.txt "${HDRS[@]}" -d "$body" "$BASE"
  fi
}

echo "== 1) initialize =="
R=$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e-test","version":"1.0"}}}')
echo "$R" | head -c 400; echo
SESSION=$(grep -i '^mcp-session-id:' /tmp/mcp_headers.txt | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"

echo "== 2) notifications/initialized =="
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
echo "ok"

echo "== 3) tools/call generate_image =="
START=$(date +%s)
R=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a cute orange cat sitting on a windowsill at sunset","aspect_ratio":"1:1","wait_seconds":90}}}')
END=$(date +%s)
echo "duration: $((END-START))s"
echo "$R" | sed 's/\\n/\n/g' | head -c 1500
echo
