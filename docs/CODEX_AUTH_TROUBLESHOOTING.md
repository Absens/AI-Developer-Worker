# Codex Auth Troubleshooting

This runbook covers Codex CLI authentication failures in Docker, especially:

```text
Your access token could not be refreshed because your refresh token was already used.
code: refresh_token_reused
```

## Why this happens

Codex OAuth refresh tokens are rotating tokens. When Codex refreshes an access
token, that refresh token is consumed and replaced with a new one.

The failure usually means that the same Codex auth state was copied or mounted
into more than one active environment. A common local setup is:

1. Codex on the host uses `C:\Users\<user>\.codex`.
2. The worker copied that same `auth.json` into Docker volume `/codex-home`.
3. Host Codex refreshes the token first.
4. The worker later tries to refresh using its stale copied token.
5. Codex rejects it with `refresh_token_reused`.

Using a single OpenAI account is fine. The important rule is that each active
environment needs its own `CODEX_HOME` auth state. Do not share or long-term
reuse a copied `auth.json` between host Codex and the worker.

## Recommended fix for Compose

Stop the worker:

```powershell
Set-Location C:\Users\gabba\projects\developer
docker compose down
```

Remove the stale Codex auth volume. The Compose-created volume is usually named
`developer_codex-home`, but confirm with `docker volume ls` if needed.

```powershell
docker volume ls
docker volume rm developer_codex-home
```

Build the image if it is not already available:

```powershell
docker compose build worker
```

Log in directly inside the worker's Docker volume. This bypasses the image
entrypoint so the container does not copy host auth from `HOST_CODEX_HOME`:

```powershell
docker compose run --rm --entrypoint codex worker login --device-auth
```

Use the same OpenAI account in the browser/device flow. This creates a fresh
worker-specific auth state under `/codex-home`.

Verify it:

```powershell
docker compose run --rm --entrypoint codex worker login status
```

Then start the worker normally:

```powershell
docker compose up --build
```

## Recommended fix for docker run

Use a dedicated volume and log in into that volume directly:

```powershell
docker volume create codex-home

docker run --rm -it `
  --entrypoint codex `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  ai-developer-worker `
  login --device-auth
```

Verify:

```powershell
docker run --rm `
  --entrypoint codex `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  ai-developer-worker `
  login status
```

After that, run the worker with the same `codex-home` volume.

## What to avoid

Avoid direct host auth mounts for continuous worker runs:

```powershell
-v "${env:USERPROFILE}\.codex:/codex-home"
```

Also avoid treating a one-time copy of host `~/.codex` as durable worker auth
while host Codex is still in use. The copy can become stale as soon as either
environment refreshes its token.

Direct host mounts or host-auth bootstrapping are acceptable only for short
debugging sessions where you understand that host and container auth can
interfere with each other.

## If the error returns

Check for multiple active workers using the same volume:

```powershell
docker ps
docker volume ls
```

Each concurrently running worker should have its own `CODEX_HOME` volume and
its own `codex login` flow, even if all of them use the same OpenAI account.

You can also avoid OAuth refresh-token state by using API key auth and
persisting it into the worker `CODEX_HOME`:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```
