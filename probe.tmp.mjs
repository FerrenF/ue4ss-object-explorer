import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['app/lib/probe-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))

const src = new Uint8Array(readFileSync('dump/UE4SS_ObjectDump.txt'))
const cols = mod.parseDump(src)
const store = new mod.DumpStore(cols)
console.log('count', cols.count, 'skipped', cols.skipped, 'types', cols.types.length)

for (const p of ['/Script/Engine', '/Game/Pal', '/Script/Water', '/Engine', '/Script/SkyCreatorPlugin']) {
  const { rows } = store.query({ pathPrefix: p })
  console.log(`pathPrefix ${p.padEnd(26)} -> ${rows.length} rows`)
}
console.log('\nrow(0):', store.row(0))
console.log('row(1):', store.row(1))
const { rows } = store.query({ nameContains: 'Package' })
console.log('\nnameContains "Package" ->', rows.length)
console.log('\ntree roots:', store.children('').slice(0, 8).map(c => `${c.separator}${c.segment}(${c.count})`))
