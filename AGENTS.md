# Repository guidance

## Purpose

This repository is a configuration-only DeepSeek Harness profile bundle. It activates the built-in `llm-pi-ai` catalog route named `openai-codex` and delegates model transport, OAuth, token refresh, credential storage, model discovery, and reasoning support to DSH.

## Boundaries

- Do not add an LLM adapter, OAuth client, token codec, credential bridge, settings card, or browser runtime.
- Do not read or write `.credentials.yaml`, `CODEX_HOME`, Pi auth files, access tokens, refresh tokens, or authorization codes.
- Do not pin or depend directly on Pi; the selected DSH installation owns its Pi version and catalog.
- Keep the shipped artifact limited to `package.json`, `cordis.patch.yml`, `README.md`, and `COMPATIBILITY.md`.
- Treat `llm-pi-ai`, `config.providers`, `openai-codex`, and `llm-pi-ai/openai-codex` as compatibility facts verified against DSH, not implementations owned here.

## Changes

Before changing compatibility, inspect the target DSH tag's base bundle, `llm-pi-ai` configuration schema, provider catalog tests, and authorization registration. Update `README.md`, `COMPATIBILITY.md`, the source checker, and tests together.

Use the locked package manager and run:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm check:dsh -- C:\path\to\deepseek-harness
pnpm pack:inspect
```

An install claim additionally requires adding the packed or local package to a disposable DSH profile, inspecting `--dump-config`, removing it, and confirming that no credential was modified.
