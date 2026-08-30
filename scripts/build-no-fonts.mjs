import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const distDir = fileURLToPath(new URL('../dist/', import.meta.url))
const buildTempRoot = fileURLToPath(new URL('../.build-temp/', import.meta.url))
const buildId = `no-fonts-${process.pid}-${Date.now()}`
const candidateDir = join(buildTempRoot, buildId, 'candidate')
const previousDir = join(buildTempRoot, buildId, 'previous')

const removeTree = (target) => {
  if (!existsSync(target)) return
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name)
    if (entry.isDirectory()) removeTree(child)
    else unlinkSync(child)
  }
  rmdirSync(target)
}

mkdirSync(dirname(candidateDir), { recursive: true })

const result = spawnSync(process.execPath, [viteCli, 'build', '--outDir', candidateDir, '--emptyOutDir'], {
  env: { ...process.env, FONT: 'none' },
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

if (result.status !== 0) process.exit(result.status ?? 1)

const forbiddenFontAsset = /(?:PingFang|MiSans|Sarasa|fira-sans)/i
const leakedAssets = readdirSync(candidateDir, { recursive: true }).filter((path) =>
  forbiddenFontAsset.test(String(path)),
)

if (leakedAssets.length > 0) {
  console.error(`Public no-fonts build contains forbidden optional font assets: ${leakedAssets.length}`)
  process.exit(1)
}

let movedPrevious = false
try {
  if (existsSync(distDir)) {
    renameSync(distDir, previousDir)
    movedPrevious = true
  }
  renameSync(candidateDir, distDir)
} catch (error) {
  if (movedPrevious && !existsSync(distDir) && existsSync(previousDir)) {
    renameSync(previousDir, distDir)
  }
  throw error
}

removeTree(previousDir)
removeTree(join(buildTempRoot, buildId))

console.log('Public no-fonts build verified and activated: no optional font assets')
