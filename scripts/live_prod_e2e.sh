#!/usr/bin/env bash
# اختبار E2E حي على الإنتاج (Vercel): generate_narrated_video عبر /mcp
# التدفق: initialize → tools/call (5 صور عامة + سيناريو عربي) → استقصاء /api/slideshow/<id> → تنزيل MP4 → تحقق
set -e
cd /home/z/my-project
BASE="${1:-https://hossamsoliman1.vercel.app}"
mkdir -p download
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

echo "== 1) صحة الإنتاج =="
curl -s --max-time 25 "$BASE/api/health" | head -c 160; echo

echo "== 2) جلسة MCP =="
curl -s -D /tmp/hp1 "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"prod-e2e","version":"1.0"}}}' \
  "$BASE/mcp" > /dev/null
SESSION=$(grep -i '^mcp-session-id:' /tmp/hp1 | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"
curl -s -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$BASE/mcp" > /dev/null

echo "== 3) استدعاء generate_narrated_video (5 صور picsum عامة + راوي عربي) =="
BODY=$(BASE_ENV="$BASE" python3 - <<'PY'
import json, os
d = json.load(open('scripts/demo_narration.json'))
# صور مخبوزة في نشر Vercel نفسه (public/demo_img_*.jpg) — صفر اعتماد على خدمات خارجية متقلبة
base = os.environ["BASE_ENV"]
imgs = [f"{base}/demo_img_{i}.jpg" for i in range(1, 6)]
args = {"images": imgs, "narration_text": d["narration"], "voice_lang": "ar",
        "resolution": "480p", "aspect_ratio": "16:9", "wait_seconds": 240}
print(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                  "params": {"name": "generate_narrated_video", "arguments": args}}))
PY
)
START=$(date +%s)
R=$(curl -s --max-time 300 -H "mcp-session-id: $SESSION" "${HDRS[@]}" -d "$BODY" "$BASE/mcp")
END=$(date +%s)
echo "رد الأداة خلال $((END-START)) ثانية"
echo "$R" | grep -oE '"text":"[^"]{0,220}' | head -1

TASK_ID=$(echo "$R" | grep -oE '/api/slideshow/[A-Za-z0-9_-]+' | head -1 | awk -F/ '{print $4}')
echo "TASK_ID: $TASK_ID"

echo "== 4) استقصاء الحالة حتى الاكتمال (حتى 6 دقائق) =="
DONE=""
for i in $(seq 1 36); do
  ST=$(curl -s --max-time 15 "$BASE/api/slideshow/$TASK_ID" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','?'), d.get('progress',''))" 2>/dev/null || echo "parse-?")
  echo "  [$i] status: $ST"
  case "$ST" in
    done*) DONE=1; break ;;
    failed*|error*) echo "LIVE_TASK_FAILED"; exit 2 ;;
  esac
  sleep 10
done
[ -n "$DONE" ] || { echo "TIMEOUT_WAITING"; exit 3; }

echo "== 5) تنزيل الفيديو الحي والتحقق من سلامته + دعم Range =="
OUT="download/ai_tools_weekly_LIVE.mp4"
curl -s --max-time 90 -o "$OUT" "$BASE/api/slideshow/$TASK_ID/video?download=1"
ls -la "$OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT" | head -8
RANGE=$(curl -s --max-time 25 -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" \
  "$BASE/api/slideshow/$TASK_ID/video")
echo "Range request → HTTP $RANGE (المتوقع 206)"
echo "VIDEO_URL: $BASE/api/slideshow/$TASK_ID/video"
echo "LIVE_E2E_DONE"
