import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import lockfile from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialLock } from '../../src/auth/lock.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'docx-lock-test-'))
  roots.push(value)
  return value
}

function target(directory: string, reference = 'OPENAI_CODEX_OAUTH'): string {
  const digest = createHash('sha256').update(reference).digest('hex')
  return join(directory, `credential-${digest}`)
}

describe('CredentialLock', () => {
  it('serializes callbacks in process and releases after a callback failure', async () => {
    const directory = await root()
    const subject = new CredentialLock({ directory, acquireTimeoutMs: 500, staleMs: 5_000 })
    const order: string[] = []
    await Promise.all([
      subject.run('ref', async () => { order.push('a-start'); await new Promise(resolve => setTimeout(resolve, 20)); order.push('a-end') }),
      subject.run('ref', async () => { order.push('b') }),
    ])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
    await expect(subject.run('ref', async () => { throw new Error('callback failure') })).rejects.toThrow('callback failure')
    await expect(subject.run('ref', async () => 'released')).resolves.toBe('released')
  })

  it('times out on a live competing process lock', async () => {
    const directory = await root()
    await mkdir(directory, { recursive: true })
    const held = await lockfile.lock(target(directory), { realpath: false, stale: 10_000, update: 5_000 })
    try {
      const subject = new CredentialLock({ directory, acquireTimeoutMs: 80, staleMs: 10_000 })
      await expect(subject.run('OPENAI_CODEX_OAUTH', async () => undefined)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' })
    } finally {
      await held()
    }
  })

  it('recovers a stale lock and never exposes the reference in its filename', async () => {
    const directory = await root()
    const lockDirectory = `${target(directory)}.lock`
    await mkdir(lockDirectory, { recursive: true })
    const old = new Date(Date.now() - 30_000)
    await utimes(lockDirectory, old, old)
    const subject = new CredentialLock({ directory, acquireTimeoutMs: 500, staleMs: 5_000 })
    await expect(subject.run('OPENAI_CODEX_OAUTH', async () => 'ok')).resolves.toBe('ok')
    expect(target(directory)).not.toContain('OPENAI_CODEX_OAUTH')
  })

  it('aborts while waiting and discards the abort reason', async () => {
    const directory = await root()
    const held = await lockfile.lock(target(directory), { realpath: false, stale: 10_000, update: 5_000 })
    try {
      const controller = new AbortController()
      setTimeout(() => { controller.abort('fake-secret-reason') }, 20)
      const subject = new CredentialLock({ directory, acquireTimeoutMs: 1_000, staleMs: 10_000 })
      await expect(subject.run('OPENAI_CODEX_OAUTH', async () => undefined, controller.signal))
        .rejects.toMatchObject({ code: 'ABORTED', message: expect.not.stringContaining('fake-secret-reason') })
    } finally {
      await held()
    }
  })

  it('prevents lost updates across independent Node processes', async () => {
    const directory = await root()
    const counter = join(directory, 'counter.txt')
    await writeFile(counter, '0')
    const worker = resolve('tests/fixtures/lock-worker.mjs')
    await Promise.all(Array.from({ length: 5 }, () => child(worker, [directory, counter, 'OPENAI_CODEX_OAUTH'])))
    expect(await readFile(counter, 'utf8')).toBe('5')
  })
})

function child(worker: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const childProcess = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    childProcess.stderr.on('data', chunk => { stderr += String(chunk) })
    childProcess.once('error', reject)
    childProcess.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`lock worker exited ${String(code)}: ${stderr}`))
    })
  })
}
