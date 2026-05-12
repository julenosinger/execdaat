#!/usr/bin/env python3
"""
Deploy direto via API REST do Cloudflare Pages.
Contorna o bug de deduplicação do wrangler 4.72 que registra 0 arquivos
no manifesto de deployment mesmo após upload bem-sucedido.

Fluxo:
  1. Calcular SHA256 de cada arquivo em dist/
  2. POST /pages/projects/{proj}/deployments (multipart/form-data)
     — incluir TODOS os arquivos como campos separados
  Cloudflare aceita multipart com os arquivos diretamente.
  Alternativa: usar a API de upload de assets em 3 etapas.
"""

import os
import sys
import hashlib
import json
import subprocess
import mimetypes
import base64
from pathlib import Path

ACCOUNT_ID   = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
API_TOKEN    = os.environ.get('CLOUDFLARE_API_TOKEN', '')
PROJECT_NAME = 'execdaatapp'
DIST_DIR     = Path('/home/user/webapp/dist')

if not ACCOUNT_ID or not API_TOKEN:
    print('ERROR: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set')
    sys.exit(1)

# ── Collect all files ─────────────────────────────────────────────────────────
print(f'Scanning {DIST_DIR}...')
all_files = {}
for fpath in sorted(DIST_DIR.rglob('*')):
    if fpath.is_file() and not any(p.startswith('.') for p in fpath.parts[len(DIST_DIR.parts):]):
        rel = '/' + str(fpath.relative_to(DIST_DIR))
        data = fpath.read_bytes()
        sha  = hashlib.sha256(data).hexdigest()
        all_files[rel] = {'path': fpath, 'data': data, 'hash': sha}

print(f'Total files: {len(all_files)}')

# ── Step 1: Get missing hashes from CF ───────────────────────────────────────
print('\nStep 1 — checking which hashes CF already has...')
hashes_payload = json.dumps({p: v['hash'] for p, v in all_files.items()})

result = subprocess.run([
    'curl', '-s', '-X', 'POST',
    f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{PROJECT_NAME}/deployments/hashes/check',
    '-H', f'Authorization: Bearer {API_TOKEN}',
    '-H', 'Content-Type: application/json',
    '-d', hashes_payload,
], capture_output=True, text=True)

try:
    resp = json.loads(result.stdout)
    if resp.get('success'):
        missing = resp.get('result', {}).get('missing', [])
        print(f'  CF needs {len(missing)} files (out of {len(all_files)} total)')
    else:
        print(f'  Hash check failed or endpoint not available: {resp}')
        missing = list(all_files.keys())  # upload all
        print(f'  Falling back: uploading ALL {len(missing)} files')
except Exception as e:
    print(f'  Could not parse hash check response: {e}')
    print(f'  Raw: {result.stdout[:500]}')
    missing = list(all_files.keys())

# ── Step 2: Upload missing files ──────────────────────────────────────────────
if missing:
    print(f'\nStep 2 — uploading {len(missing)} files...')
    # Upload in batches of 50
    BATCH = 50
    for i in range(0, len(missing), BATCH):
        batch = missing[i:i+BATCH]
        print(f'  Batch {i//BATCH + 1}: {len(batch)} files')
        
        # Build multipart form data
        cmd = ['curl', '-s', '-X', 'POST',
               f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{PROJECT_NAME}/deployments/assets/upload',
               '-H', f'Authorization: Bearer {API_TOKEN}',
        ]
        
        for rel_path in batch:
            info  = all_files[rel_path]
            fpath = info['path']
            mime  = mimetypes.guess_type(str(fpath))[0] or 'application/octet-stream'
            cmd += ['-F', f'file=@{fpath};type={mime}']
        
        r = subprocess.run(cmd, capture_output=True, text=True)
        try:
            rj = json.loads(r.stdout)
            if rj.get('success'):
                print(f'    ✓ Uploaded batch OK')
            else:
                print(f'    ✗ Upload error: {rj}')
        except Exception as e:
            print(f'    Parse error: {e}, raw: {r.stdout[:300]}')
else:
    print('\nStep 2 — no files to upload (all already in CF storage)')

# ── Step 3: Create deployment ─────────────────────────────────────────────────
print('\nStep 3 — creating deployment...')
manifest = {p: v['hash'] for p, v in all_files.items()}

deploy_payload = json.dumps({
    'branch': 'main',
    'commit_hash': subprocess.check_output(
        ['git', '-C', '/home/user/webapp', 'rev-parse', 'HEAD'],
        text=True
    ).strip(),
    'commit_message': 'fix: layout bug + clean URL routing + static assets',
    'files': manifest,
})

result = subprocess.run([
    'curl', '-s', '-X', 'POST',
    f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{PROJECT_NAME}/deployments',
    '-H', f'Authorization: Bearer {API_TOKEN}',
    '-H', 'Content-Type: application/json',
    '-d', deploy_payload,
], capture_output=True, text=True)

try:
    resp = json.loads(result.stdout)
    if resp.get('success'):
        d = resp['result']
        print(f'\n✅ Deployment created!')
        print(f'   ID:  {d.get("id")}')
        print(f'   URL: {d.get("url")}')
        print(f'   Env: {d.get("environment")}')
        aliases = d.get('aliases', [])
        if aliases:
            print(f'   Production URLs:')
            for a in aliases:
                print(f'     → {a}')
    else:
        print(f'\n✗ Deployment failed:')
        print(json.dumps(resp, indent=2))
except Exception as e:
    print(f'Parse error: {e}')
    print(f'Raw: {result.stdout[:1000]}')

