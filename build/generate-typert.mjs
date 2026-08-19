/**
 * Run DSH's official Typert generator for a standalone package.
 *
 * dsh-typert-generator 0.1.0-rc.7 discovers only projects below a workspace
 * `packages/` directory, even in package mode. This disposable, package-shaped
 * workspace supplies that expected topology without changing the repository's
 * public layout or checking generated staging files into source control.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = resolve(repository, 'build', '.typert-stage')
const stagedPackage = join(stage, 'packages', 'plugin')
const stagedProtocol = join(stage, 'packages', 'typert-protocol')
const output = join(repository, 'lib')
const keepStage = process.env.DSH_TYPERT_KEEP_STAGE === '1'

assertWithin(stage, resolve(repository, 'build'))
rmSync(stage, { recursive: true, force: true })
try {
  mkdirSync(stagedPackage, { recursive: true })
  mkdirSync(join(stagedProtocol, 'src'), { recursive: true })
  cpSync(join(repository, 'src'), join(stagedPackage, 'src'), { recursive: true })
  writeFileSync(join(stagedPackage, 'package.json'), readFileSync(join(repository, 'package.json')))
  const protocolRoot = resolve(repository, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  writeFileSync(join(stagedProtocol, 'package.json'), readFileSync(join(protocolRoot, 'package.json')))
  // The published protocol ships declarations but no src despite advertising
  // a ./src/* export. Stage its exact declarations as ambient source so the
  // analyzer can identify Remote/TypertRemoteService as protocol-owned symbols.
  stageDeclaration(join(protocolRoot, 'lib', 'types', 'index.d.ts'), join(stagedProtocol, 'src', 'index.ts'))
  stageDeclaration(join(protocolRoot, 'lib', 'types', 'types.d.ts'), join(stagedProtocol, 'src', 'types.ts'))
  writeJson(join(stage, 'tsconfig.host.json'), {
    files: [],
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['packages/typert-protocol/src/types.ts'],
      },
    },
    references: [
      { path: './packages/plugin/tsconfig.host.json' },
      { path: './packages/typert-protocol/tsconfig.host.json' },
    ],
  })
  writeJson(join(stagedPackage, 'tsconfig.host.json'), {
    extends: '../../../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      rootDir: './src',
      outDir: './lib/types',
      tsBuildInfoFile: './lib/host.tsbuildinfo',
      baseUrl: '../..',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['packages/typert-protocol/src/types.ts'],
      },
    },
    include: ['src/**/*.ts'],
    exclude: ['src/client/**'],
  })
  writeJson(join(stagedProtocol, 'tsconfig.host.json'), {
    extends: '../../../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      rootDir: './src',
      outDir: './lib/types',
      tsBuildInfoFile: './lib/host.tsbuildinfo',
    },
    include: ['src/**/*.ts'],
  })

  const generator = new WorkspaceTypertGenerator(stage)
  const discovered = generator.discover(['host'])
  const artifacts = generator.generate(['deepseek-openai-codex'], ['host'])
  const host = artifacts.find(artifact => artifact.package === 'deepseek-openai-codex' && artifact.face === 'host')
  if (host === undefined) {
    throw new Error(`deepseek-openai-codex: official Typert generator found no Host contribution; discovery=${JSON.stringify(discovered)}`)
  }
  if (host.remote === undefined) throw new Error('deepseek-openai-codex: official Typert generator found no Remote methods')

  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'typert.host.js'), host.js)
  writeFileSync(join(output, 'typert.host.d.ts'), host.dts)
  writeFileSync(join(output, 'typert.remote-client.js'), host.remote.js)
  writeFileSync(join(output, 'typert.remote-client.d.ts'), host.remote.dts)
  writeFileSync(join(output, 'typert.remote-client.d.ts.map'), host.remote.dtsMap)
} finally {
  assertWithin(stage, resolve(repository, 'build'))
  if (!keepStage) rmSync(stage, { recursive: true, force: true })
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function stageDeclaration(source, target) {
  writeFileSync(target, readFileSync(source, 'utf8'))
}

function assertWithin(path, parent) {
  if (!isAbsolute(path) || !isAbsolute(parent)) throw new Error('Typert staging paths must be absolute')
  const child = relative(parent, path)
  if (child.length === 0 || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Refusing to modify Typert staging path outside ${parent}`)
  }
}
