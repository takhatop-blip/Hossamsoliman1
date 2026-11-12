#!/usr/bin/env bash
# استكمال تدفق ربط الجهاز: استطلاع GitHub حتى يوافق المستخدم على صلاحية repo
# عند النجاح: يستبدل GITHUB_TOKEN في .env بقيمة gho_ الجديدة (لا تُطبع أبدًا)
set -u
DC_FILE="/home/z/my-project/scripts/.device_code"
ENV_FILE="/home/z/my-project/.env"
DEVICE_CODE=$(cat "$DC_FILE" 2>/dev/null)
[ -n "$DEVICE_CODE" ] || { echo "NO_DEVICE_CODE"; exit 1; }

INTERVAL=8
for i in $(seq 1 60); do   # 60 × 8s ≈ 8 دقائق
  R=$(curl -s --max-time 20 -X POST https://github.com/login/oauth/access_token \
      -H "Accept: application/json" \
      -d "client_id=178c6fc778ccc68e1d6a" \
      -d "device_code=$DEVICE_CODE" \
      -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
  ERR=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
  TOK=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  case "$ERR" in
    authorization_pending) echo "[$i] waiting user approval..." ;;
    slow_down) INTERVAL=$((INTERVAL+5)); echo "[$i] slowing down: $INTERVAL s" ;;
    expired_token) echo "DEVICE_CODE_EXPIRED"; exit 2 ;;
    "") if [ -n "$TOK" ]; then
          sed -i "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$TOK|" "$ENV_FILE"
          echo "TOKEN_OK (saved to .env, scopes will be verified separately)"
          exit 0
        else
          echo "[$i] unexpected response: $(echo "$R" | head -c 120)"
        fi ;;
    *) echo "[$i] error: $ERR"; exit 3 ;;
  esac
  sleep "$INTERVAL"
done
echo "POLL_TIMEOUT"
exit 4
