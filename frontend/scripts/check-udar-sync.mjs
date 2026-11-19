// Verify (default) or refresh (--write) the vendored UDAR_Bench core in src/compute/udar.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', '..', 'UDAR_Bench', 'source', 'src')
const dstDir = join(here, '..', 'src', 'compute', 'udar')
const write = process.argv.includes('--write')

// Must match the core list in UDAR_Bench/source/build/build.js and CORE_FILES in src/compute/udarCore.js.
const CORE_FILES = ['filters.js', 'engine1d.js', 'model.js', 'fdsolve.js', 'fd25d.js', 'fdorch.js', 'invert.js', 'jobs.js']

if (!existsSync(srcDir)) {
  console.error(`UDAR_Bench core not found: ${srcDir}`)
  process.exit(1)
}

const problems = []
const jsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
const expected = [...CORE_FILES].sort()

const srcList = jsIn(srcDir)
if (srcList.join() !== expected.join()) {
  problems.push(`UDAR_Bench core files changed: found [${srcList}], expected [${expected}]. Update CORE_FILES here and in udarCore.js.`)
}

let changed = 0
for (const f of CORE_FILES) {
  const src = join(srcDir, f)
  const dst = join(dstDir, f)
  if (!existsSync(src)) continue
  const a = readFileSync(src)
  const same = existsSync(dst) && a.equals(readFileSync(dst))
  if (same) continue
  if (write) {
    writeFileSync(dst, a)
    changed++
    console.log(`copied ${f}`)
  } else {
    problems.push(`${f} differs from UDAR_Bench/source/src/${f}`)
  }
}

const extra = jsIn(dstDir).filter((f) => !CORE_FILES.includes(f))
if (extra.length) problems.push(`unexpected files in src/compute/udar: ${extra.join(', ')}`)

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`)
  if (!write) console.error('Run "npm run sync:udar" to copy the UDAR_Bench core, or revert local edits.')
  process.exit(1)
}
console.log(write ? `UDAR core synced (${changed} file(s) updated).` : `UDAR core in sync: ${CORE_FILES.length} files byte-identical.`)
