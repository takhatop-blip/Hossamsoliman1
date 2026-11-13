#!/usr/bin/env bash
# ديمو حي: فيديو كرتوني باستايل ديزني بدون رفع أي صور —
# 5 أوصاف مشاهد (تُتولد كصور مجانًا عبر Pollinations) + سرد عربي كامل عبر generate_narrated_video
set -e
cd /home/z/my-project
BASE="${1:-https://hossamsoliman1.vercel.app}"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

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

echo "== 1) جلسة MCP =="
curl -s -D /tmp/hp_s "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"story-e2e","version":"1.0"}}}' \
  "$BASE/mcp" > /dev/null
SESSION=$(grep -i '^mcp-session-id:' /tmp/hp_s | tr -d '\r' | awk '{print $2}')
echo "SESSION: $SESSION"
curl -s -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$BASE/mcp" > /dev/null

echo "== 2) استدعاء generate_narrated_video — قصة «سمسم والصرصور المضيء» (5 مشاهد ديزنية) =="
BODY=$(python3 - <<'PY'
import json
# أسلوب ديزني موحد في بداية كل وصف مشهد — الصور تُتولد مجانًا عبر Pollinations
S = "Disney classic animation style, expressive big-eyed characters, vibrant saturated colors, whimsical fairy-tale scenery, soft magical glow, no photorealism. "
scenes = [
    S + "a cute fluffy white kitten wearing a tiny red scarf waving goodbye to his mother at the door of a cozy cottage, warm morning light, storybook village",
    S + "the same white kitten with red scarf stepping into a magical glowing forest with giant luminous mushrooms and fireflies, wide shot, wonder on his face",
    S + "the white kitten face to face with a tiny friendly glowing golden firefly, both smiling, close-up, magical bokeh background",
    S + "the white kitten and the golden firefly playing together chasing colorful butterflies between giant glowing mushrooms, joyful action shot",
    S + "the white kitten and the firefly sitting side by side on a grassy hill watching a starry night sky, firefly glowing warmly, peaceful ending shot",
]
narration = (
    "في قريبة صغيرة عند أطراف الغابة، عاش قط صغير اسمه سمسم، لا يفارق وشاحه الأحمر أبدًا. "
    "وفي صباحٍ مشرق، قرر سمسم أن يستكشف الغابة المتلألئة التي كان جدُّه يحكي له عنها. "
    "وبينما يتجوّل بين الفطر العملاق، قابل صرصورًا ليليًا صغيرًا يضيء كالنجمة، فصارا صديقين في لحظة. "
    "لعبا معًا وطاردا الفراشات الملوّنة حتى بدأت الشمس تغيب خلف التلال. "
    "ثم جلسا على التلة يتأملان النجوم، وعاد سمسم إلى بيته حاملًا حكاية جديدة يرويها كل ليلة قبل النوم."
)
args = {"images": scenes, "narration_text": narration, "voice_lang": "ar",
        "resolution": "720p", "aspect_ratio": "16:9", "wait_seconds": 240}
print(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                  "params": {"name": "generate_narrated_video", "arguments": args}}))
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
echo "TASK_ID: $TASK_ID"

if [ -z "$URL" ] && [ -n "$TASK_ID" ]; then
  echo "== 3) متابعة get_task كل 15 ثانية (توليد 5 صور مجانية ~45ث/صورة + الترميز) =="
  for i in $(seq 1 40); do
    sleep 15
    RT=$(curl -s --max-time 60 -H "mcp-session-id: $SESSION" "${HDRS[@]}" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$((10+i)),\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}" "$BASE/mcp" \
      | extract_text)
    PCT=$(echo "$RT" | grep -oE 'التقدم الحالي: [0-9]+%' | tail -1)
    echo "  [$i] ${PCT:-...}"
    URL=$(echo "$RT" | grep -oE 'الرابط المباشر: [^ ]+' | head -1 | awk '{print $NF}')
    [ -n "$URL" ] && break
    case "$RT" in *"❌ فشلت المهمة"*) echo "STORY_FAILED: $RT"; exit 2 ;; esac
  done
fi
[ -n "$URL" ] || { echo "NO_URL_TIMEOUT"; exit 3; }
echo "VIDEO_URL: $URL"

echo "== 4) تنزيل والتحقق =="
OUT="download/disney_cartoon_LIVE.mp4"
curl -s --max-time 120 -o "$OUT" "$URL"
ls -la "$OUT" | awk '{print "الحجم:",$5,"بايت"}'
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT" | head -8
ffmpeg -i "$OUT" -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
RANGE=$(curl -s --max-time 25 -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" "$URL")
echo "Range request → HTTP $RANGE (المتوقع 206)"
echo "LIVE_STORY_DONE"
