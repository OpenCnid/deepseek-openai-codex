# deepseek-openai-codex

A configuration-only DeepSeek Harness profile bundle that activates the `openai-codex` route already supplied by DSH's built-in `@deepseek-ai/dsh-llm-pi-ai` adapter.

This package contains no model adapter, OAuth implementation, credential bridge, browser code, or OpenAI transport. DSH and its pinned Pi dependency own all of those behaviors. The package contributes one `cordis.patch.yml` layer:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai-codex: {}
```

## Compatibility

The configuration is verified against DSH `0.1.2-alpha.5` (`dsh-v0.1.2-alpha.5`, commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`). It is intended for later DSH versions that preserve all of these interfaces:

- the base profile contains the `llm-pi-ai` row;
- that row accepts `config.providers` keyed by provider id;
- the installed Pi catalog contains `openai-codex`;
- DSH's Pi adapter owns the `llm-pi-ai/openai-codex` authorization record and OAuth flow.

Run the compatibility check against each new DSH source checkout before claiming support:

```powershell
pnpm check:dsh -- C:\path\to\deepseek-harness
```

Older DSH releases, including `0.1.0-rc.7`, are not supported by this branch. See [COMPATIBILITY.md](COMPATIBILITY.md) for the exact policy and limitations.

## Install

From GitHub:

```powershell
dsh plugin --profile web add github:OpenCnid/deepseek-openai-codex
```

From a local checkout:

```powershell
dsh plugin --profile web add .
```

Confirm that the bundle patched the existing provider row:

```powershell
dsh --profile web --dump-config
```

The composed `llm-pi-ai` row should contain `providers.openai-codex` exactly once. Start DSH and select any model advertised for that route; model names and reasoning levels come from DSH's installed Pi catalog rather than this repository.

## Sign in

Provider activation and authorization are separate. This bundle never reads, writes, copies, or prints an OAuth credential.

Use an authorization surface supplied by your DSH installation to authorize the native record `llm-pi-ai/openai-codex`. If that DSH build exposes no authorization UI or command, this package alone cannot perform a fresh login; use a trusted DSH embedding surface that calls the registered authorization flow or upgrade to a build that supplies one. Do not place access or refresh tokens in `settings.yaml` or this repository.

An existing native DSH credential remains usable after installing or removing this bundle. Credentials created by the retired `0.1.0-rc.7` adapter under `OPENAI_CODEX_OAUTH` are a different format and location; authorize again through DSH instead of copying them.

## Add other Pi providers

This patch replaces the composition-level `llm-pi-ai` config rather than deep-merging it. Put additional routes in the higher-priority DSH user settings document:

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
    another-provider: {}
```

DSH validates each provider against the adapter and catalog installed in that DSH version.

## Remove

```powershell
dsh plugin --profile web remove deepseek-openai-codex
```

Removal drops only this configuration layer. It does not delete `llm-pi-ai/openai-codex` credentials or alter user settings. Sign out through DSH when you also want the stored grant removed.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm check:dsh -- C:\path\to\deepseek-harness
pnpm pack:inspect
```

The packed artifact contains only the manifest, profile patch, and user documentation.
