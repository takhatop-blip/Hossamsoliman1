#!/usr/bin/env bash
# فيديو تجريبي حقيقي: "جديد أدوات الذكاء الاصطناعي" — بيانات Show HN الحية → محرك التعليق المصوّر المحلي
# يفترض خادمًا يعمل على 127.0.0.1:3000 (ابدأه بـ: npm run start)
set -e
cd /home/z/my-project
mkdir -p download

BASE="http://127.0.0.1:3000"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

echo "== 0) صحة الخادم المحلي =="
curl -s --max-time 10 "$BASE/api/health" | head -c 120; echo

echo "== 1) الأدوات المختارة (بيانات حية من Hacker News) =="
python3 -c "
import json
d=json.load(open('scripts/demo_narration.json'))
for i,t in enumerate(d['tools'],1): print(f\"  {i}. {t['title'][:70]} ({t['points']} نقطة)\")
"

echo "== 2) نداء generate_narrated_video عبر MCP =="
curl -s -D /tmp/h1 "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ai-tools-demo","version":"1.0"}}}' \
  "$BASE/mcp" > /dev/null
SESSION=$(grep -i '^mcp-session-id:' /tmp/h1 | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"
curl -s -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$BASE/mcp" > /dev/null

echo "== 1.5) تنزيل 5 صور إلى القرص المحلي وتقديمها من الخادم نفسه (مضمون) =="
IMAGES_JSON=$(python3 scripts/fetch_demo_images.py)
echo "الصور المحلية: $IMAGES_JSON"

BODY=$(IMAGES_JSON="$IMAGES_JSON" python3 - <<'PY'
import json, os
d = json.load(open('scripts/demo_narration.json'))
imgs = json.loads(os.environ["IMAGES_JSON"])
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
echo "$R" | head -c 500; echo

TASK_ID=$(echo "$R" | grep -oE '/api/slideshow/[A-Za-z0-9_-]+' | head -1 | awk -F/ '{print $4}')
echo "TASK_ID: $TASK_ID"

echo "== 3) استقصاء حالة المهمة حتى الاكتمال (حتى 4 دقائق) =="
if [ -n "$TASK_ID" ]; then
  for i in $(seq 1 48); do
    ST=$(curl -s --max-time 10 "$BASE/api/slideshow/$TASK_ID" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','?'), d.get('progress',''))" 2>/dev/null || echo "parse-?")
    echo "  [$i] status: $ST"
    case "$ST" in
      done*) break ;;
      failed*|error*) echo "TASK_FAILED"; exit 2 ;;
    esac
    sleep 5
  done
else
  echo "لم يُعثر على معرف المهمة في الرد — قد يكون الفيديو اكتمل داخل الرد نفسه"
fi

echo "== 4) تنزيل الفيديو الناتج والتحقق منه =="
OUT="download/ai_tools_weekly_demo.mp4"
curl -s --max-time 60 -o "$OUT" "$BASE/api/slideshow/$TASK_ID/video?download=1"
ls -la "$OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT" | head -8
echo "DEMO_DONE"
