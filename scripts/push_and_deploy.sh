#!/usr/bin/env bash
# دفع نسخة المحرك الداخلي للتعليق المصوّر + متابعة نشر Vercel + اختبار حي
# الاستخدام:  bash scripts/push_and_deploy.sh <GITHUB_TOKEN>
#            أو ضع GITHUB_TOKEN في .env ثم شغّل السكربت بلا وسيط
set -e
cd /home/z/my-project

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(grep -E '^GITHUB_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
fi
if [ -z "$TOKEN" ]; then
  echo "❌ لا يوجد GITHUB_TOKEN — مرّره وسيطًا أو ضعه في .env"
  exit 1
fi

echo "== 1) الدفع (force-with-lease — التزام محلي معدَّل فوق نسخة الريموت) =="
git -c credential.helper='!f() { echo username=x; echo password='"$TOKEN"'; }; f' \
  push --force-with-lease origin HEAD:main
echo "PUSH_OK"

echo "== 2) متابعة حالة النشر على GitHub (vercel/status) حتى 5 دقائق =="
SHA=$(git rev-parse HEAD)
for i in $(seq 1 30); do
  sleep 10
  ST=$(curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/takhatop-blip/Hossamsoliman1/commits/$SHA/status" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('state','pending'))" 2>/dev/null || echo "pending")
  echo "  [$i] state=$ST"
  case "$ST" in
    success) echo "DEPLOY_SUCCESS"; break ;;
    failure|error) echo "DEPLOY_FAILED"; exit 2 ;;
  esac
done

echo "== 3) فحص الصحة على الإنتاج =="
sleep 5
curl -s --max-time 30 "https://hossamsoliman1.vercel.app/api/health" | head -c 300; echo

echo "== 4) اختبار حي: generate_narrated_video =="
bash scripts/narrated_live_test.sh
