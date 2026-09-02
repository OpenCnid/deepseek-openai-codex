import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const source = process.argv[2] === '--' ? process.argv[3] : process.argv[2]
if (source === undefined) {
  console.error('Usage: pnpm check:dsh -- <path-to-deepseek-harness>')
  process.exit(2)
}

async function read(relative) {
  return readFile(path.join(source, relative), 'utf8')
}

const cliManifest = JSON.parse(await read('apps/cli/package.json'))
const basePatch = await read('packages/bundle/base/cordis.patch.yml')
const configSource = await read('packages/llm/llm-pi-ai/src/config.ts')
const catalogTests = await read('packages/llm/llm-pi-ai/tests/catalog.spec.ts')
const loginSource = await read('packages/llm/llm-pi-ai/src/login.ts')
const authSource = await read('packages/llm/llm-pi-ai/src/auth.ts')

const version = cliManifest.version

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  assert.ok(match !== null, `expected a semantic DSH version, received ${value}`)
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index]
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

assert.ok(compareSemver(version, '0.1.2-alpha.5') >= 0, `expected DSH 0.1.2-alpha.5 or later, received ${version}`)
assert.match(basePatch, /^\s*- id: llm-pi-ai\s*$/m, 'base profile must contain the llm-pi-ai row')
assert.match(configSource, /providers:\s*z\.dict\(/, 'llm-pi-ai must accept a providers dictionary')
assert.match(catalogTests, /expect\(offered\)\.toContain\('openai-codex'\)/, 'catalog tests must offer openai-codex')
assert.match(loginSource, /registerPiAiFlows/, 'llm-pi-ai must register authorization flows')
assert.match(authSource, /RECORD_SCOPE\s*=\s*'llm-pi-ai'/, 'native credentials must remain owned by llm-pi-ai')

console.log(`Compatible DSH source interfaces found in ${version}.`)
