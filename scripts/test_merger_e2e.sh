#!/usr/bin/env bash
# اختبار E2E محلي كامل لخدمة التعليق المصوّر في استدعاء واحد
set -e
cd /home/z/my-project/merger
export TURSO_DATABASE_URL="file:/tmp/merger-test.db"
export TURSO_AUTH_TOKEN="local-test"
export PORT=3101
export FFMPEG_PRESET=veryfast

node server.js > /tmp/merger-server.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null || true" EXIT
sleep 2

echo "== health =="
curl -s --max-time 5 http://localhost:3101/api/config -o /dev/null -w "config: HTTP %{http_code}\n"

echo "== create slideshow job =="
R=$(curl -s --max-time 20 -X POST http://localhost:3101/api/slideshow \
  -H "Content-Type: application/json" --data-binary @/tmp/ssbody.json)
echo "$R"
JOB=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['jobId'])")

echo "== process (blocking) =="
curl -s --max-time 280 -X POST "http://localhost:3101/api/slideshow/$JOB/process" \
  -o /tmp/ssprocess.json -w "process: HTTP %{http_code} in %{time_total}s\n"
echo "RESULT: $(cat /tmp/ssprocess.json | head -c 500)"

echo "== status =="
curl -s --max-time 10 "http://localhost:3101/api/slideshow/$JOB" | head -c 400
echo

echo "== verify video streams =="
VID=$(python3 -c "import json;print(json.load(open('/tmp/ssprocess.json')).get('videoUrl',''))")
if [ -n "$VID" ]; then
  curl -s --max-time 30 -o /tmp/ss-final.mp4 "$VID"
  ls -la /tmp/ss-final.mp4
  ffprobe -v error -show_entries "stream=codec_type,codec_name:format=duration" -of json /tmp/ss-final.mp4 | python3 -c "
import json,sys
j = json.load(sys.stdin)
print('duration:', j['format']['duration'])
for s in j['streams']:
    print('stream:', s['codec_type'], s['codec_name'])
audio = any(s['codec_type']=='audio' for s in j['streams'])
video = any(s['codec_type']=='video' for s in j['streams'])
print('VERDICT:', 'PASS — فيديو بصوت الراوي' if (audio and video) else 'FAIL — مسار ناقص')
"
  echo "== Range 206 check =="
  curl -s --max-time 15 -r 0-1023 -o /dev/null -w "range: HTTP %{http_code} bytes: %{size_download}\n" "$VID"
fi
