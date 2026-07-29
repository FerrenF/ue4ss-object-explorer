#!/usr/bin/env node
/**
 * node scripts/prebake.mjs <dump.txt> [public/dump.pdx]
 *
 * Use this when the dump ships with the site. Parsing 60 MB in the browser
 * costs about a second on a good machine and considerably more on a laptop;
 * doing it here costs nothing at runtime.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const [, , input, output = 'public/dump.pdx'] = process.argv
if (!input) {
  console.error('usage: node scripts/prebake.mjs <dump.txt> [out.pdx]')
  process.exit(1)
}

// The parser is TypeScript and shared with the app; transpile it on the fly.
const bundled = await build({
  entryPoints: ['app/lib/prebake-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
)

const src = new Uint8Array(readFileSync(input))
const t0 = performance.now()
const cols = mod.parseDump(src)
const bundle = mod.encodeBundle(cols)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, bundle)

const gz = gzipSync(bundle, { level: 6 }).length
console.log(`  input    ${(src.length / 1e6).toFixed(1)} MB`)
console.log(`  objects  ${cols.count.toLocaleString()} (${cols.skipped} unparsed)`)
console.log(`  parse    ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`  output   ${(bundle.length / 1e6).toFixed(1)} MB  ->  ${(gz / 1e6).toFixed(1)} MB gzipped`)
console.log(`  written  ${output}`)
