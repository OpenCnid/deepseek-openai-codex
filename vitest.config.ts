import { defineConfig } from 'vitest/config'
import ts from 'typescript'

export default defineConfig({
  plugins: [{
    name: 'lower-remote-decorators-for-node',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/typert/auth.remote.ts')) return undefined
      // Vite's default test transform preserves standard decorators, while
      // current Node releases do not parse them. Use the same TypeScript
      // lowering and ES2024 target as the production declaration build.
      return {
        code: ts.transpileModule(code, {
          fileName: id,
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            sourceMap: true,
            verbatimModuleSyntax: true,
          },
        }).outputText,
        map: null,
      }
    },
  }],
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    },
  },
})
