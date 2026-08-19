# deepseek-openai-codex

`deepseek-openai-codex` is a standalone DeepSeek Harness Cordis plugin that
adds the `openai-codex` provider backed by an eligible ChatGPT subscription.
DSH continues to own the agent loop, tools, approvals, sessions, and UI; the
plugin delegates OAuth, refresh, the model catalog, direct Codex request
construction, and streaming to `@earendil-works/pi-ai`.

```text
DeepSeek Harness LLM seam
  -> deepseek-openai-codex
  -> @earendil-works/pi-ai@0.84.2
  -> OpenAI Codex Responses API
```

The plugin does not launch or speak to `codex app-server`, does not require the
Codex CLI, and never falls back to `OPENAI_API_KEY`. Pi's direct request
identity—including `originator: pi` and Pi's `User-Agent`—is preserved.

## Compatibility and release status

- Supported Host: DSH `0.1.0-rc.7` / tag `dsh-v0.1.0-rc.7` only.
- Cordis: `4.0.1`.
- Pi: exactly `@earendil-works/pi-ai@0.84.2`.
- Node.js: `>=22.19.0` (verification used Node 24.19.0).
- Package state: implemented and locally packable, but intentionally private
  and not published.

The exact `0.1.0-rc.7` DSH package set is available publicly even though some
npm default tags still resolve older release candidates. No compatibility is
claimed for another DSH release. See [COMPATIBILITY.md](COMPATIBILITY.md) for
the audited exports and release gates.

npm publication remains blocked on repository-owner decisions: license,
package-name/owner approval, release visibility, and approval of the
third-party notice. The package must not be published until those are settled.

## Install from this checkout

Build and pack with the exact lockfile:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination ./dist-pack
```

Install the resulting tarball through the real DSH profile workflow:

```sh
dsh plugin --profile web add ./dist-pack/deepseek-openai-codex-0.1.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

The config dump should contain one row with id `deepseek-openai-codex`.
Installing from a package checkout also works after a build:

```sh
dsh plugin --profile web add .
```

After an approved npm release, the intended command is:

```sh
dsh plugin --profile web add deepseek-openai-codex
```

That registry command does not work today because this package has not been
published.

If pnpm 11 asks for build-script policy while installing the local tarball,
review the reported transitive packages and record an explicit `allowBuilds`
decision in the disposable profile. The assembled verification used `false`
for `@google/genai` and `protobufjs`; neither build script is needed by this
plugin's direct path.

## Sign in, recover, and log out

1. Start the DSH web profile and open **Settings → Plugins**.
2. Find **OpenAI Codex** and choose **Sign in with ChatGPT**.
3. Select Pi's browser or device-code login method and complete the prompts.
4. Confirm the card reports **Configured**, then choose a Codex model in the
   normal model picker.

The browser is only a typed interaction surface. Pi's OAuth implementation
runs on the Host, and the credential is durably committed before success is
reported. Reloading the page can resume a live attempt from the Host's bounded
event buffer. Secret answers are delivered once and are not replayed.

To cancel a live attempt, use **Cancel sign-in**. To recover from an expired or
failed attempt, use **Retry sign-in**. To remove the credential, choose **Log
out** on the same card and confirm. Logout is idempotent.

### Credential ownership warning

`OPENAI_CODEX_OAUTH` is a plugin-owned DSH credential reference. Its value is a
compact Pi OAuth credential, not a generic API key. Do not copy it into
settings, edit it by hand, reuse it for another provider, or commit it. The
plugin resolves it through `ctx.credentials` on every operation and uses a
cross-process lock for refresh and replacement.

ChatGPT subscription access and OpenAI API-key billing are separate products.
This provider uses only the subscription OAuth path; setting `OPENAI_API_KEY`
does not configure it and cannot act as a fallback.

## Configuration

The package-owned bundle row supplies complete defaults because DSH patch rows
replace configuration rather than deep-merge it.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `credentialRef` | `OPENAI_CODEX_OAUTH` | Plugin-owned DSH credential reference |
| `loginAttemptLifetimeMs` | `600000` | Live/terminal attempt retention |
| `authEventReplayCapacity` | `64` | Bounded Host auth-event replay |
| `authReadTimeoutMs` | `25000` | Long-poll timeout |
| `credentialLockAcquireTimeoutMs` | `10000` | Cross-process lock acquisition limit |
| `credentialLockStaleMs` | `30000` | Stale lock threshold |
| `lockDirectory` | unset | Optional absolute lock directory override |
| `adapterTimeoutMs` | `120000` | Provider operation timeout |

Provider id, OAuth endpoints and client protocol, Codex Responses endpoint,
and `originator: pi` are compatibility facts and are not configurable.

## Troubleshooting

- **Plan or permission error:** sign in again and confirm the ChatGPT account
  is eligible for Codex subscription access. An OpenAI API balance does not
  satisfy this route.
- **Login expired or cancelled:** retry from the Plugins card. Only one live
  attempt is allowed per Host process.
- **Read-only or shadowed credential:** make the active DSH credential provider
  for `OPENAI_CODEX_OAUTH` writable. The card diagnoses this before login.
- **Invalid stored OAuth JSON:** log out/remove the damaged plugin-owned
  credential through the active credential provider, then sign in again. The
  Host refuses to mount a usable route over invalid durable state.
- **Provider collision:** remove the other adapter/configurable provider that
  already owns `openai-codex`. This plugin fails loud rather than registering
  an alias.
- **Credential lock timeout:** stop stale DSH processes using the same
  credential reference, verify the lock directory is writable, and retry. Do
  not delete an active lock from a running process.
- **Card fails to load:** verify the profile uses the complete DSH
  `0.1.0-rc.7` web package set. The package client mounts its own generated
  Remote contribution; older client runtimes are unsupported.

## Security posture

Tokens, authorization codes, device codes, serialized credentials, and secret
prompt answers stay out of DSH settings, session/model messages, browser
persistence, RPC status payloads, logs, telemetry, snapshots, and error text.
Durable storage is owned exclusively by `ctx.credentials`. Browser URLs are
scheme-checked, RPC inputs and durable JSON are validated at their boundaries,
errors are sanitized, event buffers are bounded, and live work is aborted on
Cordis disposal. No test or recording uses a real ChatGPT credential.

## Remove

```sh
dsh plugin --profile web remove deepseek-openai-codex
```

Restart the profile after removal. The package layer, Host row, adapter route,
generated browser Remote, and settings card are withdrawn. A completed logout
removes `OPENAI_CODEX_OAUTH`; uninstall alone deliberately does not delete
credentials behind the user's back.

## Development and evidence

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm pack --dry-run
```

The suite covers credential durability/locking, cross-process modification,
auth coordination, real mounted Host Remote calls, request and stream
conversion, Pi's real direct transport, browser interactions, lifecycle, and
package metadata. See [INTEGRATION_PROOF.md](INTEGRATION_PROOF.md) for the
clean-tarball and assembled DSH acceptance record.

![Assembled OpenAI Codex auth and model/tool flow](artifacts/openai-codex-assembled-flow.gif)

The implementation specification remains in [SPEC.md](SPEC.md). Adapted DSH
conversion code is acknowledged in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
