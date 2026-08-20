# Repository guidance for coding agents

## Purpose and boundaries

This repository is a standalone DeepSeek Harness Cordis plugin. It registers
the `openai-codex` model provider and delegates subscription OAuth, model
discovery, request construction, and streaming to
`@earendil-works/pi-ai@0.84.2`.

Preserve these architecture boundaries:

- DSH owns the agent loop, tools, approvals, sessions, UI, and durable
  credential provider.
- The plugin owns the Cordis package row, auth Remote, settings card, DSH ↔ Pi
  conversion, adapter, and credential bridge.
- The provider uses Pi's direct Codex Responses path. Do not add a Codex CLI,
  `codex app-server`, `OPENAI_API_KEY`, or API-key fallback path.
- Provider id `openai-codex`, credential reference `OPENAI_CODEX_OAUTH`, and
  Pi's request identity are compatibility facts, not user configuration.

Read [SPEC.md](SPEC.md) before architecture or auth changes and
[COMPATIBILITY.md](COMPATIBILITY.md) before dependency or DSH integration
changes.

## Repository map

- `src/index.ts`: Cordis entry point and DSH registrations.
- `src/adapter.ts`, `src/context.ts`, `src/replay.ts`, `src/stream.ts`: DSH ↔ Pi
  model, message, replay, and streaming bridge.
- `src/auth/`: OAuth coordination, credential codec/store, and cross-process
  lock.
- `src/typert/`: Host auth Remote surface.
- `src/client/`: browser settings card.
- `cordis.patch.yml`: complete package-owned DSH configuration row.
- `tests/unit`, `tests/wire`, `tests/browser`, `tests/integration`: layered
  verification.
- `artifacts/`: safe assembled workflow evidence; never place a real credential
  or authorization code here.
- `INTEGRATION_PROOF.md`: acceptance evidence and release blockers.

## Setup and validation

Use the locked toolchain and dependencies:

```sh
pnpm install --frozen-lockfile
```

Run the smallest relevant tests while iterating, then the complete gate before
handoff:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm run pack:inspect
```

Target a test file with `pnpm exec vitest run <path>`. A change is not complete
when only source tests pass: packaging, generated Remote outputs, browser
registration, and exact dependency metadata are part of the contract.

## Compatibility rules

- The supported baseline is DSH `0.1.0-rc.7`, Cordis `4.0.1`, Pi AI `0.84.2`,
  and Node.js `>=22.19.0`.
- DSH peer packages move as a single audited set. Never bump one package in
  isolation or widen a range without repeating the compatibility audit.
- `cordis.patch.yml` is a complete row because DSH patch rows replace rather
  than deep-merge configuration. When adding an option, update the schema,
  defaults, patch row, tests, and relevant documentation together.
- Keep `package.json` private and do not publish or remove release gates unless
  the repository owner explicitly resolves the decisions recorded in
  `INTEGRATION_PROOF.md`.

## Security invariants

- Never log, snapshot, persist in browser storage, or return through RPC any
  token, code, device code, serialized credential, or secret prompt answer.
- Validate RPC input and stored OAuth JSON at their boundaries; keep public
  errors sanitized.
- Credentials must flow through `ctx.credentials` and the cross-process lock.
  Success may be reported only after a durable write.
- Keep auth replay bounded, deliver secret answers once, and abort live work on
  Cordis disposal.
- Tests and visual evidence must use fake credentials and visibly fake device
  codes. Before adding artifacts, inspect them for secrets and personal data.

## Change checklist

- Adapter or conversion change: update unit tests plus the wire or integration
  proof that exercises the affected request/stream behavior.
- Auth or credential change: cover durability, concurrency, cancellation,
  sanitization, and lifecycle cleanup.
- Browser card change: update browser tests and refresh only the affected safe
  screenshots/GIF when the documented flow changes.
- Packaging change: build, inspect the pack list, and verify install/remove
  behavior in a disposable DSH profile.
- Compatibility change: update `package.json`, `COMPATIBILITY.md`, `SPEC.md`,
  `INTEGRATION_PROOF.md`, and the short compatibility warning in `README.md`.

## Documentation style

Keep `README.md` as the shortest successful human path: what the plugin does,
compatibility, install, sign-in, verification, common fixes, and removal. Put
implementation rationale in `SPEC.md`, exact versions in `COMPATIBILITY.md`,
and acceptance transcripts in `INTEGRATION_PROOF.md`.

Use relative repository links, copy-pastable commands, and screenshots only
when they clarify a user action. Never claim npm availability until a release
actually exists.
