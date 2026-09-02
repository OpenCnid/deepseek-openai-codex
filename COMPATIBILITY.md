# Compatibility

## Verified baseline

The configuration-only bundle is verified against DeepSeek Harness `0.1.2-alpha.5`:

| Surface | Verified value | Required behavior |
| --- | --- | --- |
| DSH tag | `dsh-v0.1.2-alpha.5` | Profile bundles patch existing rows by id |
| DSH commit | `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5` | Source used by the compatibility and assembled-profile checks |
| Base row | `llm-pi-ai` | Mounted dormant and accepts a complete `providers` dictionary |
| Provider | `openai-codex` | Supplied by the installed Pi catalog |
| Authorization record | `llm-pi-ai/openai-codex` | Owned by DSH's Pi adapter and credential store |
| Node.js | `^22.19.0 || >=24.0.0` | Matches the verified DSH engine range |

## Future-version policy

This repository delegates provider behavior to DSH instead of copying it. Later DSH releases are compatible when the automated source check and an assembled profile install both pass. Compatibility requires the same `llm-pi-ai` row id, the same `providers` configuration field, a catalog entry for `openai-codex`, and a registered native authorization flow.

The repository does not claim unconditional compatibility with every future DSH release. A release that renames the row, changes the configuration schema, removes the catalog provider, or changes authorization ownership requires a matching configuration update here.

## Unsupported versions

DSH `0.1.0-rc.7` and the former standalone adapter are unsupported on this branch. Git history retains that implementation for users who need to inspect or recover it. No legacy runtime file is shipped by `0.2.0-alpha.1`.

## Authentication limitation

The native Pi adapter registers the OAuth flow, but a DSH application still needs a user-facing authorization surface to run it. This bundle activates the route only. It intentionally does not reintroduce the retired settings card, invoke Pi's CLI, import another application's token file, or manipulate `.credentials.yaml` directly.

## Verification

Run the source compatibility check:

```powershell
pnpm check:dsh -- C:\path\to\deepseek-harness
```

Then install the local package into a disposable profile and inspect the composed tree:

```powershell
dsh plugin --profile codex-smoke add .
dsh --profile codex-smoke --dump-config
dsh plugin --profile codex-smoke remove deepseek-openai-codex
```

For a release claim, also run one real model request using a test account or an already-authorized local credential. Never place a real grant in repository fixtures or CI.
