# Compatibility matrix

Verified on 2026-08-19 before implementation. Registry checks used exact
versions rather than npm's default dist-tags, because several DeepSeek Harness
packages currently have an older release on the default tag.

## Supported baseline

| Surface | Verified version | Required public exports | Result |
| --- | --- | --- | --- |
| DeepSeek Harness CLI/profile | `@deepseek-ai/dsh@0.1.0-rc.7` | `dsh` executable and bundle/profile plugin workflow | Published and compatible |
| Cordis | `@deepseek-ai/cordis@4.0.1` | `.` | Published |
| LLM seam | `@deepseek-ai/dsh-llm@0.1.0-rc.7` | `.`, `./types`, `./brand`, `./message` | Published; adapter, configurable-provider, model metadata, stream, replay, and error APIs present |
| Credentials seam | `@deepseek-ai/dsh-credentials@0.1.0-rc.7` | `.`, `./types` | Published; per-operation `resolve`/`describe` and durable `set`/`unset` present |
| Settings seam | `@deepseek-ai/dsh-settings@0.1.0-rc.7` | `.`, `./types` | Published; `installSettingsSection` and `settingsNamespace` present |
| Attachments | `@deepseek-ai/dsh-attachment@0.1.0-rc.7` | `.` | Published; image attachment read API present |
| Typert protocol | `@deepseek-ai/dsh-typert-protocol@0.1.0-rc.7` | `.`, `./types` | Published; Remote decorators, service binding, contribution and client types present |
| Typert loader/registry | `@deepseek-ai/dsh-typert-loader@0.1.0-rc.7`, `@deepseek-ai/dsh-typert-registry@0.1.0-rc.7` | loader `.`, registry `.`, `./client` | Published; package-local Host `./typert` discovery is present |
| Typert generator | `@deepseek-ai/dsh-typert-generator@0.1.0-rc.7` | `./tsdown` | Published; package-mode generation is usable out of tree |
| Browser runtime/slot | `@deepseek-ai/dsh-client-runtime@0.1.0-rc.7`, `@deepseek-ai/dsh-client-ui-slots@0.1.0-rc.7` | runtime `./client`, slots `.` | Published |
| Plugins settings card | `@deepseek-ai/dsh-client-ui-settings-plugins@0.1.0-rc.7` | `./client` | Published; `settings.plugin.item` declaration present |
| Browser Remote assembly | `@deepseek-ai/dsh-api-remotes@0.1.0-rc.7` | `./client` | Published; `ctx.remote.$mount()` is public, but the built-in assembly selects only first-party contributions, so this package self-mounts `./remote` before activating its card |
| Browser support packages | `@deepseek-ai/dsh-client-connection`, `-locale`, `-ui-settings`, `-web-react`, `-ui-primitives` at `0.1.0-rc.7` | their documented root or `./client` entries | Published |
| Optional browser test helper | `@deepseek-ai/dsh-client-test-runtime@0.1.0-rc.7` | `.` | Published artifact is internally inconsistent with the published client runtime: importing it fails because `ConversationEventRegistry` is not exported. Production is unaffected; tests use the closest public Cordis/slot harness plus a real assembled browser run |
| Pi | `@earendil-works/pi-ai@0.84.2` exactly | `.`, `./providers/openai-codex`, `./api/*`, `./oauth` | Published; `createModels`, `CredentialStore`, OAuth interactions, catalog provider, and direct streaming present |

The DSH source fixture is the unmodified tag `dsh-v0.1.0-rc.7`, commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Its public source declarations
match the exact `0.1.0-rc.7` package exports above. The checkout remained clean
during preflight, full workspace build, plugin installation, browser exercise,
and removal.

The separately audited Pi source fixture is commit
`59a71b235dadb4ad0d67557a8abb0aaa093e68b4`. The installed npm declaration
surface for `@earendil-works/pi-ai@0.84.2` was also inspected. The registry
metadata reports npm `gitHead` `914cf1472e715297caa30db4b9535d534a9eb718`,
not the separately audited commit. Both sources expose the required public
contract; wire tests in this repository pin the behavior of the actual npm
artifact used at runtime.

## Runtime and release gates

- Pi `0.84.2` requires Node.js `>=22.19.0`. Node 20 is unsupported. Development
  and verification use Node 24.19.0.
- `deepseek-openai-codex` returned npm `E404` during preflight, so the name was
  unclaimed at that instant. Name approval and a final availability check are
  still owner/release actions.
- npm publication remains blocked until the repository owner selects a license,
  approves the package name/owner, and approves the third-party notice for the
  DSH conversion code adapted under MIT terms.
- Browser Remote composition is package-owned: DSH's Host loader discovers
  `./typert`, while the lazy client entry mounts `./remote` and activates the
  card in a nested Cordis scope that injects the generated namespace. The real
  assembled web profile verified this lifecycle and exposed the deadlock that
  would result from declaring the nested injection on the parent entry.
- No compatibility is claimed for DSH versions before or after
  `0.1.0-rc.7`; the peer range is intentionally pinned to that release line.

## Repository state note

The supplied repository directory contains `SPEC.md`, `README.md`, and
`IMPLEMENTATION_PROMPT.md`, but no `.git` directory. Consequently there was no
repository status or history to inspect and no commit workflow to use. Existing
files are preserved and implementation changes are kept isolated to this
directory.
