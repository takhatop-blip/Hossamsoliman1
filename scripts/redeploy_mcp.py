#!/usr/bin/env python3
"""إعادة نشر إنتاجية لمشروع MCP على Vercel من GitHub main — التوكن من .env."""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = ""
for line in Path('/home/z/my-project/.env').read_text().splitlines():
    if line.startswith('VERCEL_TOKEN_1='):
        TOKEN = line.split('=', 1)[1].strip()
assert TOKEN, 'VERCEL_TOKEN_1 missing in .env'

TEAM = 'team_hSLFfBZxxJgiJBF24fsBr24R'
BASE = 'https://api.vercel.com'


def api(method, path, body=None):
    url = f"{BASE}{path}{'&' if '?' in path else '?'}teamId={TEAM}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')


st, d = api('POST', '/v13/deployments', {
    "name": "hossamsoliman1",
    "target": "production",
    "gitSource": {"type": "github", "org": "takhatop-blip", "repo": "Hossamsoliman1", "ref": "main"},
})
if st not in (200, 201):
    print('DEPLOY CREATE FAILED', st, json.dumps(d)[:300])
    raise SystemExit(1)

dep_id = d['id']
print(f"deploy started: {dep_id} url={d.get('url')}")

for i in range(60):
    time.sleep(5)
    st, d = api('GET', f"/v13/deployments/{dep_id}")
    state = d.get('readyState') or d.get('state')
    print(f"  [{i*5}s] {state}")
    if state == 'READY':
        print('READY OK — live at https://hossamsoliman1.vercel.app')
        break
    if state in ('ERROR', 'CANCELED'):
        print('FAILED:', json.dumps(d)[:500])
        raise SystemExit(1)
else:
    print('TIMEOUT waiting for deployment')
    raise SystemExit(1)
