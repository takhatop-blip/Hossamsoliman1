#!/usr/bin/env python3
"""Fix Vercel setup: MCP project framework+env+deploy, and create merger project."""
import json
import sys
import urllib.request
from pathlib import Path

# التوكن يُقرأ من متغير البيئة — لا تضع أي توكن مكتوبًا داخل الكود (المستودع عام!)
# الاستخدام: VERCEL_TOKEN_MCP=xxxx python3 scripts/vercel_setup.py
import os

TOKEN = os.environ.get("VERCEL_TOKEN_MCP", "")
TEAM = 'team_hSLFfBZxxJgiJBF24fsBr24R'
MCP_PRJ = 'hossamsoliman1'
MCP_PRJ_ID = 'prj_VYmJH7XwLRuhpjEfpWAfeqUhifub'
MERGER_PRJ = 'hossam-merger'
ORG = 'takhatop-blip'
REPO = 'Hossamsoliman1'
BASE = 'https://api.vercel.com'


def api(method, path, body=None):
    url = f"{BASE}{path}"
    if '?' in path:
        url += f"&teamId={TEAM}"
    else:
        url += f"?teamId={TEAM}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')


def load_env():
    env = {}
    for line in Path('/home/z/my-project/.env.local').read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def upsert_env(project, key, value):
    # delete if exists, then create
    st, d = api('DELETE', f"/v10/projects/{project}/env/{key}")
    body = {"key": key, "value": value, "type": "encrypted",
            "target": ["production", "preview"], "gitBranchEnabled": False}
    st, d = api('POST', f"/v10/projects/{project}/env", body)
    print(f"  env {key}: http={st} {'OK' if st in (200, 201) else d}")
    return st in (200, 201)


def deploy(project, extra_settings=None):
    body = {
        "name": project,
        "target": "production",
        "gitSource": {"type": "github", "org": ORG, "repo": REPO, "ref": "main"},
    }
    if extra_settings:
        body["projectSettings"] = extra_settings
    st, d = api('POST', '/v13/deployments', body)
    if st in (200, 201):
        print(f"  deploy {project}: id={d.get('id')} url={d.get('url')}")
        return d.get('id')
    print(f"  deploy {project} FAILED http={st}: {json.dumps(d)[:400]}")
    return None


env = load_env()
DB_URL = env.get('TURSO_DATABASE_URL', '')
DB_TOKEN = env.get('TURSO_AUTH_TOKEN', '')
assert DB_URL and DB_TOKEN, 'Turso creds missing in .env.local'

print('== 1) Fix MCP project (framework=nextjs, env vars) ==')
st, d = api('PATCH', f"/v9/projects/{MCP_PRJ_ID}", {"framework": "nextjs"})
print(f"  PATCH framework: http={st} framework={d.get('framework')}")
upsert_env(MCP_PRJ, 'TURSO_DATABASE_URL', DB_URL)
upsert_env(MCP_PRJ, 'TURSO_AUTH_TOKEN', DB_TOKEN)
st, d = api('GET', f"/v9/projects/{MCP_PRJ_ID}/domains")
print('  domains:', [x.get('name') for x in d.get('domains', [])])

print('== 2) Create merger project ==')
st, d = api('POST', '/v10/projects', {"name": MERGER_PRJ, "framework": None})
print(f"  create: http={st} id={d.get('id', d)}")
st, d = api('PATCH', f"/v9/projects/{MERGER_PRJ}",
            {"rootDirectory": "merger", "ssoProtection": None, "framework": None})
print(f"  PATCH rootDir/protection: http={st} rootDirectory={d.get('rootDirectory')} sso={d.get('ssoProtection')}")
upsert_env(MERGER_PRJ, 'TURSO_DATABASE_URL', DB_URL)
upsert_env(MERGER_PRJ, 'TURSO_AUTH_TOKEN', DB_TOKEN)

print('== 3) Deploy MCP (production) ==')
mcp_dpl = deploy(MCP_PRJ)
print('== 4) Deploy merger (production, root=merger) ==')
mg_dpl = deploy(MERGER_PRJ, {"framework": None, "rootDirectory": "merger"})

print('DEPLOY_IDS', json.dumps({"mcp": mcp_dpl, "merger": mg_dpl}))
