#!/usr/bin/env bash
# اختبار E2E حي على الإنتاج: generate_cartoon_video (ديزني، من النص بلا صور)
# الاستخدام: bash scripts/live_cartoon_e2e.sh [BASE] [TASK_ID]
#   - بلا TASK_ID: ينشئ مهمة جديدة ثم يتتبعها.
#   - بـ TASK_ID (من استدعاء سابق): يتتبعها فقط دون إنشاء مهمة مكررة (توفير رصيد).
# الردود قد تصل JSON أو SSE (event: message / data: {...}) — المحلل يدعم الشكلين.
set -e
cd /home/z/my-project
BASE="${1:-https://hossamsoliman1.vercel.app}"
PRESET_TASK="${2:-}"
mkdir -p download
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

# يستخرج نص المحتوى من رد JSON أو SSE — ويطبع PARSE_FAIL عند الفشل
# ملاحظة: python3 -c (لا heredoc) حتى يبقى stdin للردود المُمرَّرة عبر الأنبوب
extract_text() {
  python3 -c '
import sys, json
raw = sys.stdin.read().strip()
data = None
if raw.startswith("event:") or raw.startswith("data:") or "\ndata:" in raw:
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                data = json.loads(line[5:].strip())
            except Exception:
                pass
else:
    try:
        data = json.loads(raw)
    except Exception:
        data = None
if isinstance(data, dict) and "result" in data and "content" in data["result"]:
    print(data["result"]["content"][0]["text"])
elif isinstance(data, dict) and "error" in data:
    print("JSONRPC_ERROR: " + json.dumps(data["error"], ensure_ascii=False))
else:
    print("PARSE_FAIL")
'
}

echo "== 1) صحة الإنتاج =="
curl -s --max-time 25 "$BASE/api/health" | head -c 130; echo

if [ -z "$PRESET_TASK" ]; then
  echo "== 2) جلسة MCP =="
  curl -s -D /tmp/hp_c "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cartoon-e2e","version":"1.0"}}}' \
    "$BASE/mcp" > /dev/null
  SESSION=$(grep -i '^mcp-session-id:' /tmp/hp_c | tr -d '\r' | awk '{print $2}')
  echo "SESSION: $SESSION"
  curl -s -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$BASE/mcp" > /dev/null

  echo "== 3) التحقق من تسجيل الأداة في tools/list =="
  TL=$(curl -s --max-time 30 -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$BASE/mcp")
  echo "$TL" | grep -o '"name":"[a-z_]*"' | sort -u
  echo "$TL" | grep -q '"name":"generate_cartoon_video"' || { echo "TOOL_MISSING"; exit 4; }

  echo "== 4) استدعاء generate_cartoon_video (ستايل ديزني، 8 ثوانٍ) =="
  BODY=$(P="A cute little white kitten wearing a tiny red scarf exploring a magical glowing garden at night, meets a friendly talking firefly, laughs and chases it between giant glowing mushrooms, joyful and whimsical mood" python3 - <<'PY'
import json, os
args = {"prompt": os.environ["P"], "style": "disney", "duration": 8,
        "aspect_ratio": "16:9", "resolution": "480p", "enable_audio": True, "wait_seconds": 240}
print(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                  "params": {"name": "generate_cartoon_video", "arguments": args}}))
PY
)
  START=$(date +%s)
  R=$(curl -s --max-time 300 -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$BODY" "$BASE/mcp")
  END=$(date +%s)
  echo "رد الأداة خلال $((END-START)) ثانية"
  TEXT=$(echo "$R" | extract_text)
  echo "$TEXT" | head -2
  URL=$(echo "$TEXT" | grep -oE 'الرابط المباشر: [^ ]+' | head -1 | awk '{print $NF}')
  TASK_ID=$(echo "$TEXT" | grep -oE 'task_id: [A-Za-z0-9_-]+' | head -1 | awk '{print $NF}')
else
  TASK_ID="$PRESET_TASK"
  echo "== استئناف تتبع المهمة القائمة: $TASK_ID =="
  curl -s -D /tmp/hp_c "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cartoon-e2e","version":"1.0"}}}' \
    "$BASE/mcp" > /dev/null
  SESSION=$(grep -i '^mcp-session-id:' /tmp/hp_c | tr -d '\r' | awk '{print $2}')
  curl -s -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$BASE/mcp" > /dev/null
  URL=""
fi
echo "TASK_ID: $TASK_ID"

if [ -z "$URL" ] && [ -n "$TASK_ID" ]; then
  echo "== 5) متابعة get_task كل 10 ثوانٍ (حتى 7 دقائق) =="
  for i in $(seq 1 42); do
    sleep 10
    RT=$(curl -s --max-time 60 -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$((10+i)),\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}" "$BASE/mcp" \
      | extract_text)
    PCT=$(echo "$RT" | grep -oE 'التقدم الحالي: [0-9]+%' | tail -1)
    echo "  [$i] ${PCT:-...}"
    URL=$(echo "$RT" | grep -oE 'الرابط المباشر: [^ ]+' | head -1 | awk '{print $NF}')
    [ -n "$URL" ] && break
    case "$RT" in *"❌ فشلت المهمة"*) echo "CARTOON_FAILED: $RT"; exit 2 ;; esac
  done
fi
[ -n "$URL" ] || { echo "NO_URL_TIMEOUT"; exit 3; }
echo "VIDEO_URL: $URL"

echo "== 6) تنزيل والتحقق =="
OUT="download/disney_cartoon_LIVE.mp4"
curl -s --max-time 90 -o "$OUT" "$URL"
ls -la "$OUT" | awk '{print "الحجم:",$5,"بايت"}'
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT" | head -8
ffmpeg -i "$OUT" -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
RANGE=$(curl -s --max-time 25 -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" "$URL")
echo "Range request → HTTP $RANGE (المتوقع 206)"
echo "LIVE_CARTOON_DONE"
