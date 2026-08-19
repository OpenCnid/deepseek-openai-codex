import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('standalone package and DSH bundle metadata', () => {
  it('pins the audited runtime and exposes only package-owned build artifacts', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const dependencies = manifest['dependencies'] as Record<string, string>
    const exports = manifest['exports'] as Record<string, unknown>
    const files = manifest['files'] as string[]

    expect(manifest).toMatchObject({
      name: 'deepseek-openai-codex',
      private: true,
      type: 'module',
      engines: { node: '>=22.19.0' },
    })
    expect(manifest).not.toHaveProperty('license')
    expect(dependencies['@earendil-works/pi-ai']).toBe('0.84.2')
    expect(Object.keys(exports).sort()).toEqual([
      '.', './client', './cordis.patch.yml', './package.json', './remote', './typert', './types',
    ])
    expect(files.some(path => path.startsWith('src/') || path.startsWith('tests/'))).toBe(false)
    expect(manifest['dsh']).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-settings-plugins'],
      },
    })
  })

  it('ships one complete Host row with every deployment default', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/^\s*- id: deepseek-openai-codex$/gm)).toHaveLength(1)
    for (const expected of [
      'name: deepseek-openai-codex',
      'credentialRef: OPENAI_CODEX_OAUTH',
      'loginAttemptLifetimeMs: 600000',
      'authEventReplayCapacity: 64',
      'authReadTimeoutMs: 25000',
      'credentialLockAcquireTimeoutMs: 10000',
      'credentialLockStaleMs: 30000',
      'adapterTimeoutMs: 120000',
    ]) expect(patch).toContain(expected)
  })

  it('uses the official Typert generator and keeps staging bounded to build/', async () => {
    const generator = await readFile(resolve(root, 'build/generate-typert.mjs'), 'utf8')
    expect(generator).toContain("from '@deepseek-ai/dsh-typert-generator'")
    expect(generator).toContain("resolve(repository, 'build', '.typert-stage')")
    expect(generator).toContain('assertWithin(stage')
    expect(generator).toContain("writeFileSync(join(output, 'typert.host.js')")
    expect(generator).toContain("writeFileSync(join(output, 'typert.remote-client.js')")
  })
})
