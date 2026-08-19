# Integration proof

Verified on 2026-08-19 against an unmodified DeepSeek Harness checkout at tag
`dsh-v0.1.0-rc.7`, commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, using Node 24.19.0 and pnpm
11.19.0.

## Repository and packed artifact

The implementation checks passed with 9 test files and 60 tests:

```text
pnpm run typecheck       PASS
pnpm run lint            PASS (no warnings)
pnpm run test            PASS (9 files, 60 tests)
pnpm run build           PASS
pnpm pack --dry-run      PASS; file list inspected
```

A clean consumer installed `deepseek-openai-codex-0.1.0.tgz` and imported the
root Host face, `./typert`, and `./remote`. All seven generated Remote
descriptors loaded, the installed Pi version resolved to `0.84.2`, and a
separate TypeScript consumer successfully imported the type-only `./types`
export with `tsc --skipLibCheck`.

The tarball contains compiled Host/client JavaScript, declarations, generated
Typert Host and Remote contributions, the bundle patch, README, compatibility
matrix, and third-party notice. It contains no TypeScript source, tests,
credentials, integration artifacts, local paths, or license selected without
owner approval.

## Real DSH CLI install and boot

The local tarball was installed into a fresh isolated `web` profile using:

```text
dsh plugin --profile web add <absolute-path>/deepseek-openai-codex-0.1.0.tgz
```

The command succeeded through DSH's real pnpm-backed profile workflow. pnpm 11
required explicit supply-chain decisions for the unrelated transitive build
scripts `@google/genai` and `protobufjs`; both were set to `false` in the
disposable profile and installation then completed.

`dsh --profile web --dump-config` contained exactly one
`- id: deepseek-openai-codex` Host row. The Host booted at a loopback web URL
with both `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` removed. The live LLM provider
RPC returned exactly one active `openai-codex` provider, and the installed
browser bundle rendered exactly one **OpenAI Codex** card without rebuilding
DSH.

## Keyless fake auth and model/tool transcript

No real credential or OpenAI request was used. The assembled Host process was
loaded with the test-only interception fixture
`tests/fixtures/assembled-fake-fetch.mjs`, which is excluded from the npm
package. It blocked unexpected outbound network requests and supplied only
obviously fake OAuth and SSE responses.

The real UI and Host completed this sequence:

1. The card began Pi's device-code login and displayed `SAFE-DEMO`.
2. Four intercepted polls and one intercepted token exchange exercised Pi's
   real OAuth control flow.
3. The credential was committed through the real DSH credentials service and
   the card changed to **Configured**.
4. The model picker displayed one **OpenAI Codex (ChatGPT subscription)** group
   with Pi's catalog; `GPT-5.4` was selected.
5. A real assembled DSH session sent the fake prompt through this plugin and
   Pi's direct Codex request builder.
6. The first fake SSE response requested DSH's `read` tool for `README.md`.
   DSH ran the tool and sent its result back through the adapter.
7. The continuation response rendered: “Fake Codex round trip complete: the
   README tool result returned through DSH.” The UI reported one turn and two
   steps.
8. Logout was confirmed in the UI; the card returned to **Not configured** and
   the credential file contained no plugin credential.

The sanitized transport facts are in
[`artifacts/assembled-fake-trace.jsonl`](artifacts/assembled-fake-trace.jsonl).
They prove the Codex path, `originator: pi`, Pi User-Agent recognition, model,
available tool names, and the continuation carrying a tool result. The extra
tool-less request in the trace is DSH's title-generation pass. No bearer token,
refresh token, authorization code, account id, prompt text, response body, or
credential serialization is recorded.

The visual walkthrough is
[`artifacts/openai-codex-assembled-flow.gif`](artifacts/openai-codex-assembled-flow.gif).
It shows the real installed profile's sign-in initiation, fake device-code
interaction, configured state, provider/model selection, DSH tool round trip,
and logout.

## Real removal and checkout cleanliness

Removal used the real CLI:

```text
dsh plugin --profile web remove deepseek-openai-codex
```

After restart:

```text
Host config rows named deepseek-openai-codex: 0
LLM providers named openai-codex:             0
Settings cards named OpenAI Codex:             0
Model-page provider labels:                    0
Profile package dependency:                    absent
```

`git status --short` in the DSH checkout was empty after dependency install,
full DSH build, plugin add, boot, browser exercise, and plugin remove. `HEAD`
remained `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. The separately inspected
Pi checkout also remained unmodified.

## Release-only blockers

The production integration is compatible with the published exact DSH
`0.1.0-rc.7` package set. npm publication is still blocked until the owner:

- selects a repository/package license;
- approves the npm name, owner, and public/private release posture;
- rechecks name availability immediately before publication; and
- approves `THIRD_PARTY_NOTICES.md`.

No behavior or test requirement is otherwise left behind for the supported
baseline.
