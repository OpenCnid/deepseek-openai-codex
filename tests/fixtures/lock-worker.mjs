import { readFile, writeFile } from 'node:fs/promises'
import { CredentialLock } from '../../src/auth/lock.ts'

const [directory, counterPath, reference] = process.argv.slice(2)
if (!directory || !counterPath || !reference) throw new Error('missing lock worker arguments')

const lock = new CredentialLock({ directory, acquireTimeoutMs: 5_000, staleMs: 10_000 })
await lock.run(reference, async () => {
  const value = Number(await readFile(counterPath, 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 25))
  await writeFile(counterPath, String(value + 1))
})
