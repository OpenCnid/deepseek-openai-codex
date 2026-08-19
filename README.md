# deepseek-openai-codex

`deepseek-openai-codex` is a planned standalone plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It will let the Harness use OpenAI Codex models authorized by a ChatGPT subscription while the Harness continues to own the agent loop, tools, sessions, approvals, and user interface.

The provider path is direct:

```text
DeepSeek Harness LLM seam
  -> deepseek-openai-codex
  -> @earendil-works/pi-ai
  -> OpenAI Codex Responses API
```

It does not embed or proxy `codex app-server` and does not require the Codex CLI.
The plugin will use Pi's supported OAuth and direct Codex transport, including Pi's `originator: pi` request identity.

## Status

Specification only; implementation has not started.

- [Standalone plugin specification](SPEC.md)
- [Fresh-session implementation prompt](IMPLEMENTATION_PROMPT.md)

The intended future installation command is:

```sh
dsh plugin --profile web add deepseek-openai-codex
```

The package is not published yet, so that command is not expected to work today.

## Project boundary

The implementation belongs entirely in this repository.
It must install through DeepSeek Harness's public out-of-tree plugin surfaces and must not require tracked changes to DeepSeek Harness or Pi.
