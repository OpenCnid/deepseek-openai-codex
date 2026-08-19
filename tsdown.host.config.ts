import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'deepseek-openai-codex/host',
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: false,
})
