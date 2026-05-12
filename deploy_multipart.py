#!/usr/bin/env python3
"""
Deploy para Cloudflare Pages via multipart/form-data.
Replica exatamente o que o wrangler faz internamente.
API: POST /accounts/{id}/pages/projects/{proj}/deployments
     Content-Type: multipart/form-data
     Fields:
       - manifest   (JSON string com {"/path": "sha256hex", ...})
       - /path/file (os arquivos como campos separados, usando o hash como nome)
"""
import os, sys, json, hashlib, mimetypes, subprocess
from pathlib import Path
import urllib.request, urllib.parse
import email.mime.multipart, email.mime.base, email.mime.application
import io, random, string

ACCOUNT_ID   = os.environ['CLOUDFLARE_ACCOUNT_ID']
API_TOKEN    = os.environ['CLOUDFLARE_API_TOKEN']
PROJECT_NAME = 'execdaatapp'
DIST_DIR     = Path('/home/user/webapp/dist')

# ── Coletar arquivos ──────────────────────────────────────────────────────────
print(f'Escaneando {DIST_DIR}...')
all_files = {}
for fpath in sorted(DIST_DIR.rglob('*')):
    if fpath.is_file():
        parts_rel = fpath.parts[len(DIST_DIR.parts):]
        if any(p.startswith('.') for p in parts_rel):
            continue
        rel  = '/' + str(fpath.relative_to(DIST_DIR))
        data = fpath.read_bytes()
        sha  = hashlib.sha256(data).hexdigest()
        mime = mimetypes.guess_type(str(fpath))[0] or 'application/octet-stream'
        all_files[rel] = {'path': fpath, 'data': data, 'hash': sha, 'mime': mime}

print(f'Total de arquivos: {len(all_files)}')

# ── Montar payload multipart ──────────────────────────────────────────────────
# O wrangler usa: campo "manifest" (JSON) + campos com nome = hash_hex para cada arquivo
boundary = '----WebKitFormBoundary' + ''.join(random.choices(string.ascii_letters + string.digits, k=16))

def make_part_text(name, value):
    return (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
        f'{value}\r\n'
    ).encode()

def make_part_file(name, filename, mime, data):
    header = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        f'Content-Type: {mime}\r\n\r\n'
    ).encode()
    return header + data + b'\r\n'

body_parts = []

# Campo manifest: {"/<path>": "<sha256>", ...}
manifest = {p: v['hash'] for p, v in all_files.items()}
body_parts.append(make_part_text('manifest', json.dumps(manifest)))

# Cada arquivo como campo com nome = hash
for rel_path, info in all_files.items():
    fname = info['path'].name
    body_parts.append(make_part_file(
        name     = info['hash'],
        filename = fname,
        mime     = info['mime'],
        data     = info['data'],
    ))

body_parts.append(f'--{boundary}--\r\n'.encode())
body = b''.join(body_parts)

print(f'Payload multipart: {len(body)/1024:.1f} KB')

# ── Commit info ───────────────────────────────────────────────────────────────
commit_hash = subprocess.check_output(
    ['git', '-C', '/home/user/webapp', 'rev-parse', 'HEAD'], text=True
).strip()

# ── Enviar deploy ─────────────────────────────────────────────────────────────
url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{PROJECT_NAME}/deployments'

# Usar curl para enviar (mais confiável que urllib para multipart grande)
import tempfile, os as _os
tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.multipart')
tmp.write(body)
tmp.close()

print(f'\nEnviando deploy para {PROJECT_NAME}...')
result = subprocess.run([
    'curl', '-s', '-X', 'POST', url,
    '-H', f'Authorization: Bearer {API_TOKEN}',
    '-H', f'Content-Type: multipart/form-data; boundary={boundary}',
    '--data-binary', f'@{tmp.name}',
], capture_output=True, text=True, timeout=120)

_os.unlink(tmp.name)

try:
    resp = json.loads(result.stdout)
    if resp.get('success'):
        d = resp['result']
        print(f'\n✅ Deploy OK!')
        print(f'   ID:  {d.get("id")}')
        print(f'   URL: {d.get("url")}')
        env = d.get('environment', '')
        print(f'   Env: {env}')
        aliases = d.get('aliases', [])
        for a in aliases:
            print(f'   → {a}')
        # Mostrar quantos arquivos foram registrados
        file_count = len(d.get('deployment_trigger', {}).get('metadata', {}).get('pages_build_output_dir', ''))
        print(f'\n   Arquivos no manifesto: {len(manifest)}')
    else:
        print(f'\n✗ Deploy falhou:')
        print(json.dumps(resp, indent=2)[:2000])
except Exception as e:
    print(f'Erro ao parsear resposta: {e}')
    print(f'Raw ({len(result.stdout)} bytes): {result.stdout[:1000]}')
    if result.stderr:
        print(f'Stderr: {result.stderr[:500]}')

