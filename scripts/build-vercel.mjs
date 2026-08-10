/**
 * build-vercel.mjs
 * 
 * Build script for Vercel deployment.
 * 
 * The Vercel runtime works differently from Cloudflare Pages:
 *   - api/index.ts  → compiled automatically by Vercel as a Serverless Function
 *   - Static assets → served from outputDirectory (dist-vercel/)
 * 
 * This script:
 *   1. Generates Tailwind CSS from source
 *   2. Copies public/ folder to dist-vercel/ so Vercel can serve
 *      static assets (JS, CSS, images) directly from its CDN edge.
 * 
 * NO Cloudflare-specific build is needed here (no _worker.js, no wrangler).
 */

import { cpSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT     = join(__dirname, '..')
const OUT_DIR  = join(ROOT, 'dist-vercel')
const PUB_DIR  = join(ROOT, 'public')

// Clean output directory
if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true, force: true })
}
mkdirSync(OUT_DIR, { recursive: true })

// Generate Tailwind CSS
console.log('Generating Tailwind CSS...')
execSync('npx @tailwindcss/cli -i ./src/tailwind.css -o ./public/static/tailwind.css --minify', {
  cwd: ROOT, stdio: 'inherit'
})

// Copy public/ → dist-vercel/
cpSync(PUB_DIR, OUT_DIR, { recursive: true })

console.log('✅ Vercel build complete:')
console.log(`   tailwind.css + ${PUB_DIR} → ${OUT_DIR}`)
console.log('')
console.log('   Static assets will be served by Vercel CDN.')
console.log('   API routes will be handled by api/index.ts (Serverless Function).')
