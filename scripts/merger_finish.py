#!/usr/bin/env python3
"""Auto-configure the newly imported merger project, deploy it, link it to MCP, and E2E test."""
import json
import sys
import time
import urllib.request
from pathlib import Path

TOKEN = 'REDACTED'
TEAM = 'team_hSLFfBZxxJgiJBF24fsBr24R'
MCP_PRJ = 'hossamsoliman1'
MCP_PRJ_ID = 'prj_VYmJH7XwLRuhpjEfpWAfeqUhifub'
EXPECTED = 'hossam-merger'
ORG, REPO = 'takhatop-blip', 'Hossamsoliman1'
BASE = 'https://api.vercel.com'


def api(method, path, body=None, timeout=30):
    url = f"{BASE}{path}" + (f"&teamId={TEAM}" if '?' in path else f"?teamId={TEAM}")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
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


def wait_deploy(dpl_id, minutes=8):
    for _ in range(minutes * 4):
        st, d = api('GET', f'/v13/deployments/{dpl_id}')
        rs = d.get('readyState')
        if rs in ('READY', 'ERROR', 'CANCELED'):
            print(f"  deployment {dpl_id[:16]}… → {rs}")
            return rs
        time.sleep(15)
    print(f"  deployment {dpl_id[:16]}… → TIMEOUT")
    return 'TIMEOUT'


def upsert_env(project, key, value):
    api('DELETE', f'/v10/projects/{project}/env/{key}')
    st, d = api('POST', f'/v10/projects/{project}/env',
                {"key": key, "value": value, "type": "encrypted",
                 "target": ["production", "preview"], "gitBranchEnabled": False})
    print(f"  env {key}: http={st} {'OK' if st in (200, 201) else d}")


env = load_env()
DB_URL, DB_TOKEN = env['TURSO_DATABASE_URL'], env['TURSO_AUTH_TOKEN']

print('== 1) Find the new project ==')
st, d = api('GET', '/v9/projects?limit=20')
projects = d.get('projects', [])
new = [p for p in projects if p.get('name') != MCP_PRJ]
if not new:
    print('NO_NEW_PROJECT_YET')
    sys.exit(2)
prj = new[0]
name = prj['name']
print(f"  found: {name} (id {prj['id']})")

print('== 2) Configure (root=merger, framework=Other, protection off) ==')
st, d = api('PATCH', f"/v9/projects/{prj['id']}",
            {"rootDirectory": "merger", "framework": None, "ssoProtection": None})
print(f"  PATCH: http={st} rootDirectory={d.get('rootDirectory')} framework={d.get('framework')}")
upsert_env(name, 'TURSO_DATABASE_URL', DB_URL)
upsert_env(name, 'TURSO_AUTH_TOKEN', DB_TOKEN)

print('== 3) Deploy merger (production) ==')
st, d = api('POST', '/v13/deployments', {
    "name": name, "target": "production",
    "gitSource": {"type": "github", "org": ORG, "repo": REPO, "ref": "main"},
    "projectSettings": {"framework": None, "rootDirectory": "merger"}})
if st not in (200, 201):
    print(f"  DEPLOY FAILED http={st}: {json.dumps(d)[:300]}")
    sys.exit(3)
dpl_id = d['id']
print(f"  deploying: {d.get('url')}")
rs = wait_deploy(dpl_id)
if rs != 'READY':
    sys.exit(4)

st, d = api('GET', f'/v9/projects/{prj["id"]}/domains')
domains = [x['name'] for x in d.get('domains', [])]
merger_url = f"https://{domains[0]}" if domains else f"https://{d.get('url')}"
print(f"  merger production URL: {merger_url}")

print('== 4) Test merger /api/config ==')
with urllib.request.urlopen(f'{merger_url}/api/config', timeout=30) as r:
    print(' ', r.read().decode()[:200])

print('== 5) Link MERGER_API_BASE into MCP project ==')
upsert_env(MCP_PRJ, 'MERGER_API_BASE', merger_url)
st, d = api('POST', '/v13/deployments', {
    "name": MCP_PRJ, "target": "production",
    "gitSource": {"type": "github", "org": ORG, "repo": REPO, "ref": "main"}})
if st in (200, 201):
    print(f"  MCP redeploy: {d.get('url')}")
    wait_deploy(d['id'])
else:
    print(f"  MCP REDEPLOY FAILED http={st}: {json.dumps(d)[:200]}")

print('== 6) Verify MCP health sees merger ==')
mcp_url = 'https://hossamsoliman1.vercel.app'
time.sleep(5)
with urllib.request.urlopen(f'{mcp_url}/api/health', timeout=30) as r:
    h = json.loads(r.read().decode())
    print('  ok:', h.get('ok'), '| merger.base:', h.get('merger', {}).get('base'),
          '| healthy:', h.get('merger', {}).get('healthy'))

print('MERGER_URL', merger_url)
print('ALL_DONE')
