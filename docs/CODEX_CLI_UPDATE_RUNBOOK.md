# Codex CLI Update Runbook

This runbook explains how to safely update the worker's Codex CLI integration when `@openai/codex` changes behavior, flags, auth flow, or output shape.

Use it whenever you:

- rebuild the Docker image with a newer Codex CLI,
- change the installed Codex version intentionally,
- notice that Codex auth, `codex exec`, or `resume` behavior changed,
- want to validate that a newer Codex release did not silently break the worker.

Current target for this repository, checked on 2026-06-15:

- stable production target: `@openai/codex@0.139.0`
- alpha line: `0.140.0-alpha.*`; do not select it for production Docker images

Upstream release notes reviewed for `0.130.0` -> `0.139.0`:

- [0.131.0](https://github.com/openai/codex/releases/tag/rust-v0.131.0) added `codex doctor`, improved auth and sandbox reliability, and introduced profile-v2 work.
- [0.132.0](https://github.com/openai/codex/releases/tag/rust-v0.132.0) added `--output-schema` support to `codex exec resume`.
- [0.134.0](https://github.com/openai/codex/releases/tag/rust-v0.134.0) made `--profile` the primary profile selector and rejected legacy profile configs through migration guidance.
- [0.136.0](https://github.com/openai/codex/releases/tag/rust-v0.136.0) improved `CODEX_API_KEY` remote registration and ChatGPT auth refresh diagnostics.
- [0.137.0](https://github.com/openai/codex/releases/tag/rust-v0.137.0), [0.138.0](https://github.com/openai/codex/releases/tag/rust-v0.138.0), and [0.139.0](https://github.com/openai/codex/releases/tag/rust-v0.139.0) primarily changed TUI, plugin, MCP, sandbox, image, auth, and Desktop/App Server behavior. The non-interactive `exec --json`, `resume`, `review`, `--output-last-message`, and image-attachment contracts used by this worker remain present in `0.139.0`.

## What this worker depends on

The current integration relies on these Codex CLI behaviors:

1. `codex login status` exits with `0` when auth is usable.
2. `codex exec --json` emits JSONL events to `stdout`.
3. `codex exec --output-last-message <file>` writes the final assistant message to a file.
4. `codex exec resume <threadId>` continues a previous non-interactive session id emitted by `thread.started.thread_id`.
5. `--sandbox`, `--model`, and `--profile` remain valid `codex exec` flags.
6. `codex exec --help` and `codex exec resume --help` include `--image` so Tracker screenshot context can be passed to the model.
7. `codex exec review --help` exposes `--base`, `--uncommitted`, `--json`, `--output-last-message`, `--skip-git-repo-check`, and `--ephemeral` for the optional self-review gate.

If any of those contracts change, the worker may still build but fail at runtime.

## Files to review after a Codex CLI update

Always review these files together:

- [Dockerfile](/C:/Users/gabba/projects/developer/Dockerfile)
- [config.ts](/C:/Users/gabba/projects/developer/src/config.ts)
- [auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts)
- [runner.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/runner.ts)
- [orchestrator.ts](/C:/Users/gabba/projects/developer/src/domain/orchestrator.ts)
- [codexRunner.test.ts](/C:/Users/gabba/projects/developer/tests/codexRunner.test.ts)
- [worker.smoke.test.ts](/C:/Users/gabba/projects/developer/tests/worker.smoke.test.ts)

## Recommended update procedure

### 1. Check the target Codex CLI version

On the host:

```bash
npm view @openai/codex version
```

Inside the built image or local environment:

```bash
codex --version
```

The Docker image pins `@openai/codex@0.139.0` by default through `CODEX_CLI_VERSION`.
Build the target image explicitly after this runbook passes:

```bash
docker build --build-arg CODEX_CLI_VERSION=0.139.0 -t ai-developer-worker:codex-0.139.0 .
```

Do not replace the pin with `@latest`. `codex update` exists for local CLI installations, but pinned Docker runtime images should not self-update during build or startup.

### 2. Review upstream CLI surface before changing this repo

Run the automated static contract verifier:

```bash
npm run verify:codex-cli
```

To verify a version before installing it globally or rebuilding Docker, run the verifier through a launcher:

```bash
CODEX_CLI_COMMAND=npx CODEX_CLI_ARGS_JSON='["-y","@openai/codex@0.139.0"]' npm run verify:codex-cli
```

For manual inspection, also check the current help output:

```bash
codex --help
codex exec --help
codex exec resume --help
codex exec review --help
codex login status --help
```

Confirm that these flags and subcommands still exist:

- `exec`
- `exec resume`
- `--json`
- `--output-last-message`
- `--sandbox`
- `--model`
- `--profile`
- `--image`
- `codex exec review --help`
- `--base`
- `--uncommitted`
- `--json`
- `--output-last-message`
- `--skip-git-repo-check`
- `--ephemeral`
- `login status`

If any of them changed, update the worker before rebuilding production images.

### 3. Re-check auth expectations

Validate both supported auth paths:

```bash
codex login status
```

and, if API key auth is used:

```bash
echo $CODEX_API_KEY
```

The worker treats these as valid auth sources:

- `CODEX_HOME` with a working Codex login
- `CODEX_API_KEY`

`OPENAI_API_KEY` alone does not skip the worker preflight. If you want to use an
OpenAI API key through Codex CLI auth storage, persist it first:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

If upstream changes auth precedence or stops supporting `CODEX_API_KEY`, update [auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts).

### 4. Re-check non-interactive output format

Run a minimal `exec` command against a disposable repo or temp folder:

```bash
codex exec --json --output-last-message /tmp/codex-last.txt --skip-git-repo-check "say hello"
```

Confirm:

- `stdout` is still JSONL
- a `thread.started` event still exposes a `thread_id`
- the final assistant message is still written to the output file
- error events still appear in JSON mode in a parseable form, including both nested `error.message` and top-level `message`

If JSONL event names or fields changed, update [runner.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/runner.ts).

### 5. Re-check resume semantics

Verify that a thread started with `codex exec` can still be resumed with:

```bash
codex exec resume <threadId> "continue"
```

If resume behavior changes, inspect:

- how `threadId` is emitted in JSONL
- whether `resume` still accepts the same positional shape (`codex exec ... resume <SESSION_ID>`)
- whether extra flags must move before or after `resume`

If needed, update both [runner.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/runner.ts) and [orchestrator.ts](/C:/Users/gabba/projects/developer/src/domain/orchestrator.ts).

### 6. Re-check worker config contract

These env vars define the integration surface:

- `CODEX_CLI_COMMAND`
- `CODEX_CLI_ARGS_JSON`
- `CODEX_SANDBOX`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `CODEX_EXEC_ARGS_JSON`
- `CODEX_QUESTION_MARKER`

`CODEX_CLI_ARGS_JSON` is for launcher/global Codex args that must appear before
`exec`, for example `["--search","--ask-for-approval","never"]`.
In Codex CLI `0.139.0`, examples should prefer `never` or `on-request`; avoid
`--ask-for-approval on-failure`, which is deprecated in the help output.
`CODEX_EXEC_ARGS_JSON` is for flags accepted by `codex exec --help`, for example
`["--add-dir","/workspace/shared"]`.

If Codex changes how launcher args or exec args should be passed, update:

- [.env.example](/C:/Users/gabba/projects/developer/.env.example)
- [README.md](/C:/Users/gabba/projects/developer/README.md)
- [config.ts](/C:/Users/gabba/projects/developer/src/config.ts)

## Required verification after any update

Run these commands in this repo:

```bash
npm run verify:codex-cli
npm run typecheck
npm test
npm run build
```

If the CLI/output/auth contract changed, also run the focused tests first:

```bash
npx vitest run tests/codexAuth.test.ts tests/codexRunner.test.ts tests/orchestrator.test.ts tests/worker.smoke.test.ts
```

Container verification for the pinned image:

```bash
docker build --build-arg CODEX_CLI_VERSION=0.139.0 -t ai-developer-worker:codex-0.139.0 .
docker run --rm --entrypoint codex ai-developer-worker:codex-0.139.0 --version
docker run --rm --entrypoint codex ai-developer-worker:codex-0.139.0 exec --help
docker run --rm --entrypoint npm ai-developer-worker:codex-0.139.0 run verify:codex-cli
```

Run the live/auth probe only in a disposable environment with valid network and Codex auth:

```bash
docker run --rm \
  -e CODEX_CONTRACT_LIVE=1 \
  -e CODEX_HOME=/tmp/codex-home \
  -v codex-home:/tmp/codex-home \
  --entrypoint npm \
  ai-developer-worker:codex-0.139.0 \
  run verify:codex-cli
```

Rollback build command for the previous known-good line:

```bash
docker build --build-arg CODEX_CLI_VERSION=0.130.0 -t ai-developer-worker:codex-0.130.0 .
```

## Common breakpoints to look for

Most Codex CLI update regressions will show up in one of these places:

1. `login status` still exists but exit behavior changed.
2. `exec --json` still runs but JSONL field names changed.
3. `--output-last-message` still exists but the file is empty or delayed.
4. `resume` still exists but expects different argument ordering.
5. sandbox defaults changed and the worker unexpectedly loses write access.
6. profile/model flags moved or changed names.
7. the CLI starts requiring a first-run interactive setup that the container cannot satisfy.
8. global flags such as `--search` or `--ask-for-approval` are put after `exec` and fail argument parsing.
9. `codex exec review` loses JSONL or `--output-last-message` support, which breaks the optional self-review gate.

## Practical rule

Do not treat a Codex CLI update as "just rebuild Docker".

For this worker, a Codex update is safe only after:

1. checking upstream CLI help and behavior,
2. re-validating auth,
3. re-validating `exec` JSON/output behavior,
4. re-validating `resume`,
5. running this repo's tests and build.
