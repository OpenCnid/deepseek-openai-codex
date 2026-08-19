# Fresh-session implementation prompt

Copy the prompt below into a new Codex session whose workspace is this repository.

---

You are in the `deepseek-openai-codex` repository.
Implement [`SPEC.md`](SPEC.md) end to end as a standalone, out-of-tree Cordis plugin for DeepSeek Harness.

The repository currently contains a specification, not implementation code.
Read `SPEC.md` completely before editing anything, and treat it as normative.
Also read `README.md`, inspect the repository status and history, and preserve any user changes already present.

The intended result is one npm package named `deepseek-openai-codex` that:

- registers the `openai-codex` route through DSH's public LLM seam;
- uses `@earendil-works/pi-ai@0.84.2` for OAuth, refresh, model catalog, direct Codex request construction, and streaming;
- stores the Pi OAuth credential through DSH's `ctx.credentials` service with cross-process atomic modification;
- contributes its own Settings → Plugins card and plugin-owned Typert Remote;
- installs through its own `dsh.bundle` and `dsh.client` metadata;
- preserves Pi's direct request identity, including `originator: pi`;
- requires no tracked change to DeepSeek Harness or Pi;
- does not use or launch `codex app-server` and does not require the Codex CLI.

Start with the compatibility preflight required by section 5:

1. Verify the package name and the exact Pi version from the registry.
2. Enumerate the DSH/Cordis packages and public exports the implementation needs.
3. Check whether one compatible published DSH package set exposes those APIs.
4. Clone or use a separate checkout of DSH tag `dsh-v0.1.0-rc.7` (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`) as a read-only source and assembled-test fixture.
5. Inspect Pi at commit `59a71b235dadb4ad0d67557a8abb0aaa093e68b4` and the installed `@earendil-works/pi-ai@0.84.2` declarations/exports.
6. Record the verified compatibility matrix in the repository before building on it.

If compatible DSH packages are not published, do not pretend the release path works.
You may continue development against the pinned, unmodified DSH checkout as SPEC.md allows, but keep local `file:`, `link:`, tarball, and absolute-path dependencies out of committed package metadata and clearly mark npm publication as blocked.
If an essential API is neither public nor usable from a clean external package, stop that portion, document the exact missing export and smallest upstream requirement, and continue every independent part that remains implementable.

Implementation rules:

- Work only in this repository except for read-only inspection and disposable integration fixtures.
- Never edit a DSH or Pi checkout to make the plugin pass.
- Use public package exports only; do not depend on unshipped `src/*` paths.
- Pin Pi exactly to `0.84.2`.
- Let Pi own OAuth protocol, token refresh, provider catalog, request construction, and transport.
- Let DSH own the agent loop, tools, sessions, approvals, settings shell, and durable credential provider.
- Do not introduce an App Server fallback.
- Do not fall back from subscription OAuth to an OpenAI API key.
- Preserve `originator: pi` and Pi's `User-Agent`; lock this in a real request-builder wire test.
- Treat every token, code, secret answer, and serialized credential as secret; prove it never reaches logs, RPC status payloads, sessions, snapshots, telemetry, browser persistence, or errors.
- Use a maintained dependency for cross-process locking rather than inventing a lock protocol.
- Make every Cordis registration and live resource effect-owned and disposal-safe.
- Validate configuration and wire/durable inputs at their entry points; trust typed same-process values.
- Fail loud on service absence, invalid stored OAuth JSON, read-only credential storage, and `openai-codex` route collisions.
- Do not publish npm, select a license, or weaken a requirement without owner approval.

Build in the phases from SPEC.md section 18:

1. compatibility matrix and scaffold;
2. credential codec/store/lock;
3. adapter and direct wire tests;
4. Host auth coordinator and Typert Remote;
5. browser settings card;
6. assembled DSH install/remove proof, package smoke, docs, and safe GIF.

Keep the work testable after each phase.
Use small, cohesive commits when the repository workflow permits commits.
Before each commit, inspect the full diff and stage explicit paths only.
Do not erase or overwrite unrelated work.

Testing is part of the implementation, not a follow-up.
Create the unit, cross-process, wire, Host Remote, browser, packaging, and assembled-profile coverage required by SPEC.md section 16.
Run at least:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm pack --dry-run
```

Inspect the pack list and perform a clean packed-artifact import/install smoke.
Install the local package into a clean DSH web profile through the actual `dsh plugin` command, verify `--dump-config`, boot it, exercise the keyless fake flow, remove it, and prove the DSH checkout remains clean.
Do not use a real ChatGPT credential in automated tests or recordings.

Use the sources linked in SPEC.md section 20 as primary evidence.
When implementation reality requires a design correction, update SPEC.md and README.md in the same change and explain the concrete evidence for the correction.
Do not silently narrow behavior or leave placeholder tests for a required path.

At handoff, report:

- what was implemented;
- supported and blocked DSH versions;
- every check actually run and its result;
- the assembled install/remove evidence;
- any remaining release-only owner decisions;
- any unmet requirement with an exact blocker and proposed next action.

---
