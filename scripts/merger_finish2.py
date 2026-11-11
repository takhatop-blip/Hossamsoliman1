#!/usr/bin/env python3
"""Finish setup using the hossam-merger-scope token: configure, deploy, link to MCP, verify."""
import json
import time
import urllib.request
from pathlib import Path

TOKEN_NEW = 'REDACTED'  # scope: hossam-merger
TOKEN_OLD = 'REDACTED'  # scope: team_hSLF… (MCP)
TEAM_OLD = 'team_hSLFfBZxxJgiJBF24fsBr24R'
MCP_PRJ = 'hossamsoliman1'
ORG, REPO = 'takhatop-blip', 'Hossamsoliman1'
BASE = 'https://api.vercel.com'


def api(token, method, path, body=None, team=None, timeout=30):
    url = f"{BASE}{path}"
    qs = []
    if team:
        qs.append(f"teamId={team}")
    if qs:
        url += ('&' if '?' in url else '?') + '&'.join(qs)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {token}')
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


def wait_deploy(token, team, dpl_id, minutes=8):
    for _ in range(minutes * 4):
        st, d = api(token, 'GET', f'/v13/deployments/{dpl_id}', team=team)
        rs = d.get('readyState')
        if rs in ('READY', 'ERROR', 'CANCELED'):
            return rs
        time.sleep(15)
    return 'TIMEOUT'


def upsert_env(token, team, project, key, value):
    api(token, 'DELETE', f'/v10/projects/{project}/env/{key}', team=team)
    st, d = api(token, 'POST', f'/v10/projects/{project}/env',
                {"key": key, "value": value, "type": "encrypted",
                 "target": ["production", "preview"], "gitBranchEnabled": False}, team=team)
    print(f"  env {key}: http={st} {'OK' if st in (200, 201) else json.dumps(d)[:200]}")


env = load_env()
DB_URL, DB_TOKEN = env['TURSO_DATABASE_URL'], env['TURSO_AUTH_TOKEN']

print('== 1) Discover new-token scope and project ==')
st, d = api(TOKEN_NEW, 'GET', '/v9/projects?limit=20')
cands = [p for p in d.get('projects', [])]
team_new = None
if not cands:
    st2, t = api(TOKEN_NEW, 'GET', '/v2/teams')
    for tm in t.get('teams', []):
        st3, d3 = api(TOKEN_NEW, 'GET', f"/v9/projects?limit=20&teamId={tm['id']}")
        if d3.get('projects'):
            team_new = tm['id']
            cands = d3['projects']
            break
print('  projects visible:', [p.get('name') for p in cands], '| team:', team_new or '(default)')
prj = cands[0] if cands else None
if not prj:
    print('NO_PROJECT_VISIBLE')
    raise SystemExit(2)
name = prj['name']
print(f"  target project: {name} (id {prj['id']})")

print('== 2) Configure: root=merger, framework=Other, protection off ==')
st, d = api(TOKEN_NEW, 'PATCH', f"/v9/projects/{prj['id']}",
            {"rootDirectory": "merger", "framework": None, "ssoProtection": None}, team=team_new)
print(f"  PATCH: http={st} rootDir={d.get('rootDirectory')} framework={d.get('framework')} sso={d.get('ssoProtection')}")
upsert_env(TOKEN_NEW, team_new, name, 'TURSO_DATABASE_URL', DB_URL)
upsert_env(TOKEN_NEW, team_new, name, 'TURSO_AUTH_TOKEN', DB_TOKEN)

print('== 3) Deploy merger (production) ==')
st, d = api(TOKEN_NEW, 'POST', '/v13/deployments', {
    "name": name, "target": "production",
    "gitSource": {"type": "github", "org": ORG, "repo": REPO, "ref": "main"},
    "projectSettings": {"framework": None, "rootDirectory": "merger"}}, team=team_new)
if st not in (200, 201):
    print(f"  DEPLOY FAILED http={st}: {json.dumps(d)[:300]}")
    raise SystemExit(3)
print(f"  deploying: {d.get('url')}")
rs = wait_deploy(TOKEN_NEW, team_new, d['id'])
print(f"  result: {rs}")
if rs != 'READY':
    raise SystemExit(4)

st, d = api(TOKEN_NEW, 'GET', f"/v9/projects/{prj['id']}/domains", team=team_new)
domains = [x['name'] for x in d.get('domains', [])]
merger_url = f"https://{domains[0]}" if domains else f"https://{name}.vercel.app"
print(f"  merger production URL: {merger_url}")

print('== 4) Test merger /api/config ==')
time.sleep(3)
with urllib.request.urlopen(f'{merger_url}/api/config', timeout=30) as r:
    print(' ', r.read().decode()[:220])

print('== 5) Link MERGER_API_BASE into MCP project (old token) ==')
upsert_env(TOKEN_OLD, TEAM_OLD, MCP_PRJ, 'MERGER_API_BASE', merger_url)
st, d = api(TOKEN_OLD, 'POST', '/v13/deployments', {
    "name": MCP_PRJ, "target": "production",
    "gitSource": {"type": "github", "org": ORG, "repo": REPO, "ref": "main"}}, team=TEAM_OLD)
if st in (200, 201):
    print(f"  MCP redeploy: {d.get('url')}")
    rs = wait_deploy(TOKEN_OLD, TEAM_OLD, d['id'])
    print(f"  result: {rs}")
else:
    print(f"  MCP REDEPLOY FAILED http={st}: {json.dumps(d)[:200]}")

print('== 6) Verify MCP health sees merger ==')
time.sleep(5)
with urllib.request.urlopen('https://hossamsoliman1.vercel.app/api/health', timeout=30) as r:
    h = json.loads(r.read().decode())
    print('  ok:', h.get('ok'), '| merger.base:', h.get('merger', {}).get('base'),
          '| merger.healthy:', h.get('merger', {}).get('healthy'))

print('MERGER_URL', merger_url)
print('ALL_DONE')
