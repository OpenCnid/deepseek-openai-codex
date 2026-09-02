import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

async function text(name) {
  return readFile(new URL(`../${name}`, import.meta.url), 'utf8')
}

test('the package publishes only the configuration bundle and documentation', async () => {
  const manifest = JSON.parse(await text('package.json'))

  assert.equal(manifest.version, '0.2.0-alpha.1')
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.deepEqual(manifest.files, ['cordis.patch.yml', 'README.md', 'COMPATIBILITY.md'])
  assert.equal(manifest.main, undefined)
  assert.equal(manifest.bin, undefined)
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.dsh.client, undefined)
})

test('the patch only activates the built-in openai-codex route', async () => {
  const patch = await text('cordis.patch.yml')

  assert.match(patch, /^# [\s\S]*\n- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex: \{\}\n$/)
  assert.doesNotMatch(patch, /\binsert\b/)
  assert.doesNotMatch(patch, /gpt-|reasoning|credential|token/i)
})

test('legacy runtime and browser entry points are absent', async () => {
  for (const path of ['src', 'build', 'artifacts', 'tsconfig.json', 'vitest.config.ts']) {
    await assert.rejects(access(new URL(`../${path}`, import.meta.url)))
  }
  assert.equal(root.endsWith('deepseek-openai-codex\\') || root.endsWith('deepseek-openai-codex/'), true)
})

test('documentation states the delegated behavior and authentication limitation', async () => {
  const readme = await text('README.md')
  const compatibility = await text('COMPATIBILITY.md')

  assert.match(readme, /configuration-only/i)
  assert.match(readme, /0\.1\.2-alpha\.5/)
  assert.match(readme, /package alone cannot perform a fresh login/i)
  assert.match(compatibility, /does not claim unconditional compatibility/i)
  assert.match(compatibility, /activates the route only/i)
})
