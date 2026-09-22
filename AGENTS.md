# Agent Instructions

Guidelines for AI agents working on this codebase.

## Project Overview

This is a Cloudflare Worker that runs [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot/Clawdbot) in a Cloudflare Sandbox container. It provides:
- Proxying to the OpenClaw gateway (web UI + WebSocket)
- Admin UI at `/_admin/` for device management
- API endpoints at `/api/*` for device pairing
- Debug endpoints at `/debug/*` for troubleshooting

**Note:** The CLI tool and npm package are now named `openclaw`. Config files use `.openclaw/openclaw.json`. Legacy `.clawdbot` paths are supported for backward compatibility during transition.

## Project Structure

```
src/
├── index.ts          # Main Hono app, route mounting
├── sandbox.ts        # Sandbox Durable Object subclass (serialized gateway startup)
├── types.ts          # TypeScript type definitions
├── config.ts         # Constants (ports, timeouts, paths)
├── persistence.ts    # Snapshot backup/restore of /home/openclaw
├── cron/             # Workers Cron Trigger handlers
│   ├── handler.ts    # Entry point: scheduled backups + cron wake
│   ├── backup.ts     # Automatic backup scheduling
│   └── wake.ts       # Wake container before OpenClaw cron jobs
├── auth/             # Cloudflare Access authentication
│   ├── jwt.ts        # JWT verification
│   ├── jwks.ts       # JWKS fetching and caching
│   └── middleware.ts # Hono middleware for auth
├── gateway/          # OpenClaw gateway management
│   ├── process.ts    # Process lifecycle (find, start)
│   ├── startup.ts    # ensureStarted: restore + start once, crash recovery
│   ├── token-script.ts # Gateway token auto-fill for the Control UI
│   ├── forwarded-headers.ts # Rebuild X-Forwarded-* for proxied requests
│   ├── env.ts        # Environment variable building
│   └── utils.ts      # Shared utilities (waitForProcess)
├── routes/           # API route handlers
│   ├── api.ts        # /api/* endpoints (devices, gateway)
│   ├── admin.ts      # /_admin/* static file serving
│   └── debug.ts      # /debug/* endpoints
└── client/           # React admin UI (Vite)
    ├── App.tsx
    ├── api.ts        # API client
    └── pages/
```

## Key Patterns

### Environment Variables

- `DEV_MODE` - Skips CF Access auth (maps to `OPENCLAW_DEV_MODE` for container). OpenClaw >= 2026.9 removed `controlUi.allowInsecureAuth`, so it no longer bypasses device pairing
- `DEBUG_ROUTES` - Enables `/debug/*` routes (disabled by default)
- See `src/types.ts` for full `MoltbotEnv` interface

### Gateway Startup

Always start the gateway with `sandbox.ensureStarted()` (RPC to the `Sandbox` Durable Object in `src/sandbox.ts`), never `ensureGateway()` directly. All isolates reach the same Durable Object, which runs restore + start at most once however many requests race (the loading page's `/api/status` poll and the browser's favicon request used to start two gateways on every cold start). Pass `{ waitForReady: false }` to only kick off startup, and `{ recover: true }` after seeing the gateway stop listening: under the lock it kills stale processes only if the port is still closed. `start-openclaw.sh` also takes a `flock` during onboard/config as a container-side guard.

### Proxy Headers

OpenClaw >= 2026.9 answers 403 `proxy_attribution_required` when a request carries forwarded headers (`X-Forwarded-*`, `X-Real-IP`, `Forwarded`) unless it comes from a `gateway.trustedProxies` address and yields a non-loopback client IP. Cloudflare adds these headers to every request, so the Worker must pass proxied requests through `withTrustedForwardedHeaders()` (drops all client-supplied forwarded headers, sets `X-Forwarded-For` from `CF-Connecting-IP`), and `start-openclaw.sh` trusts private and loopback ranges, since only the Sandbox platform can reach the container port.

### Upgrading OpenClaw

Bump the version in the `Dockerfile` (check `npm view openclaw@<version> engines.node`) and redeploy. On first start with existing state, `start-openclaw.sh` runs `openclaw doctor --fix --non-interactive --yes` once per OpenClaw version (marker: `~/.openclaw/.moltworker-doctor-version`), because newer versions refuse to start until old state is migrated (2026.9 moved sessions to SQLite). The migration can take several minutes on Cloudflare, and it only persists once a snapshot is taken, so trigger "Backup Now" after the first successful start. Migrations are one-way: snapshots taken after an upgrade may not load on the old version, so keep a copy of the last pre-upgrade snapshot (e.g. under `archive/` in R2, outside the rotation) before upgrading. Test the migration locally against a downloaded snapshot on a native-arch image — `@openclaw/fs-safe` needs `openat2`, which amd64 emulation on Apple Silicon doesn't implement.

### Image Generation (Workers AI plugin)

`plugins/workers-ai-image/` is an OpenClaw plugin that registers image-generation provider `workers-ai` for the built-in `image_generate` tool, calling the Workers AI REST API (`/ai/run/<model>`) with the container's AI Gateway token (needs Workers AI Read). FLUX.2 models only accept multipart form data; FLUX.1 schnell and Leonardo models take JSON; responses carry base64 in `result.image`. The image copies plugins and skills to `/opt/moltworker/` (outside the restored home dir) and `start-openclaw.sh` adds them to `plugins.load.paths` / `skills.load.extraDirs`, and sets `agents.defaults.mediaModels.image.primary` (override with `IMAGE_GENERATION_MODEL`). Workers AI has no video models, so `video_generate` needs another provider. Test plugin changes with `openclaw infer image generate --json` on a native-arch container.

### Gateway Token Auto-Fill

The Control UI sends the gateway token inside the signed WebSocket `connect` frame and stores it in per-tab sessionStorage, so the Worker can't inject it on the wire. Instead `src/gateway/token-script.ts` injects `<script src="/_moltworker/gateway-token.js">` into proxied HTML; the script adds `#token=` to the URL when the tab has no stored token, which the UI picks up and strips. The gateway's CSP only allows `script-src 'self'`, so the script must be same-origin, not inline.

### Custom Domain

`vite.config.ts` reads `WORKER_CUSTOM_DOMAIN` (environment or gitignored `.env.local`) at build time and, when set, adds it as a custom domain and disables `workers.dev`. Keep deployment-specific hostnames out of `wrangler.jsonc`. Container SSH (`ssh` + `authorized_keys`, ssh-ed25519 only) is configured directly in `wrangler.jsonc`; the Vite plugin emits `ssh` as `wrangler_ssh` in the built config, which is expected.

### CLI Commands

When calling the OpenClaw CLI from the worker, always include `--url ws://localhost:18789`:
```typescript
sandbox.startProcess('openclaw devices list --json --url ws://localhost:18789')
```

CLI commands take 10-15 seconds due to WebSocket connection overhead. Use `waitForProcess()` helper in `src/routes/api.ts`.

### Success Detection

The CLI outputs "Approved" (capital A). Use case-insensitive checks:
```typescript
stdout.toLowerCase().includes('approved')
```

## Commands

```bash
npm test              # Run tests (vitest)
npm run test:watch    # Run tests in watch mode
npm run build         # Build worker + client
npm run deploy        # Build and deploy to Cloudflare (always use this; bare `wrangler deploy` reuses a stale dist/)
npm run dev           # Vite dev server
npm run start         # wrangler dev (local worker)
npm run typecheck     # TypeScript check
```

## Testing

Tests use Vitest. Test files are colocated with source files (`*.test.ts`).

Current test coverage:
- `auth/jwt.test.ts` - JWT decoding and validation
- `auth/jwks.test.ts` - JWKS fetching and caching
- `auth/middleware.test.ts` - Auth middleware behavior
- `gateway/env.test.ts` - Environment variable building
- `gateway/process.test.ts` - Process finding logic
- `persistence.test.ts` - Snapshot create and restore
- `cron/backup.test.ts` - Automatic backup scheduling
- `cron/wake.test.ts` - Cron wake-ahead logic

When adding new functionality, add corresponding tests.

## Code Style

- Use TypeScript strict mode
- Prefer explicit types over inference for function signatures
- Keep route handlers thin - extract logic to separate modules
- Use Hono's context methods (`c.json()`, `c.html()`) for responses

## Documentation

- `README.md` - User-facing documentation (setup, configuration, usage)
- `AGENTS.md` - This file, for AI agents

Development documentation goes in AGENTS.md, not README.md.

---

## Architecture

```
Browser
   │
   ▼
┌─────────────────────────────────────┐
│     Cloudflare Worker (index.ts)    │
│  - Starts OpenClaw in sandbox       │
│  - Proxies HTTP/WebSocket requests  │
│  - Passes secrets as env vars       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│     Cloudflare Sandbox Container    │
│  ┌───────────────────────────────┐  │
│  │     OpenClaw Gateway          │  │
│  │  - Control UI on port 18789   │  │
│  │  - WebSocket RPC protocol     │  │
│  │  - Agent runtime              │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker that manages sandbox lifecycle and proxies requests |
| `Dockerfile` | Container image based on `cloudflare/sandbox` with Node 22 + OpenClaw |
| `start-openclaw.sh` | Startup script: onboard → config patch → launch gateway |
| `wrangler.jsonc` | Cloudflare Worker + Container configuration |

## Local Development

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your ANTHROPIC_API_KEY
npm run start
```

### Environment Variables

For local development, create `.dev.vars`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
DEV_MODE=true           # Skips CF Access auth
DEBUG_ROUTES=true       # Enables /debug/* routes
```

### WebSocket Limitations

Local development with `wrangler dev` has issues proxying WebSocket connections through the sandbox. HTTP requests work but WebSocket connections may fail. Deploy to Cloudflare for full functionality.

## Docker Image Caching

The Dockerfile includes a cache bust comment. When changing `start-openclaw.sh`, bump the version:

```dockerfile
# Build cache bust: 2026-02-06-v28-openclaw-upgrade
```

## Gateway Configuration

OpenClaw configuration is built at container startup:

1. The Worker restores `/home/openclaw` from R2 before starting the gateway (see R2 Storage Notes)
2. If no config exists, `openclaw onboard --non-interactive` creates one based on env vars
3. `start-openclaw.sh` patches the config for channels, gateway auth, and trusted proxies
4. Gateway starts with `openclaw gateway --allow-unconfigured --bind lan`

### AI Provider Priority

The startup script selects the auth choice based on which env vars are set:

1. **Cloudflare AI Gateway** (native): `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_GATEWAY_ID`
2. **Direct Anthropic**: `ANTHROPIC_API_KEY` (optionally with `ANTHROPIC_BASE_URL`)
3. **Direct OpenAI**: `OPENAI_API_KEY`
4. **Legacy AI Gateway**: `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL` (routes through Anthropic base URL)

### Container Environment Variables

These are the env vars passed TO the container (internal names):

| Variable | Config Path | Notes |
|----------|-------------|-------|
| `ANTHROPIC_API_KEY` | (env var) | OpenClaw reads directly from env |
| `OPENAI_API_KEY` | (env var) | OpenClaw reads directly from env |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | (env var) | Native AI Gateway key |
| `CF_AI_GATEWAY_ACCOUNT_ID` | (env var) | Account ID for AI Gateway |
| `CF_AI_GATEWAY_GATEWAY_ID` | (env var) | Gateway ID for AI Gateway |
| `OPENCLAW_GATEWAY_TOKEN` | `--token` flag | Mapped from `MOLTBOT_GATEWAY_TOKEN` |
| `OPENCLAW_DEV_MODE` | (none) | Mapped from `DEV_MODE`; `controlUi.allowInsecureAuth` no longer exists in OpenClaw >= 2026.9 |
| `TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` | |
| `DISCORD_BOT_TOKEN` | `channels.discord.token` | |
| `SLACK_BOT_TOKEN` | `channels.slack.botToken` | |
| `SLACK_APP_TOKEN` | `channels.slack.appToken` | |

## OpenClaw Config Schema

OpenClaw has strict config validation. Common gotchas:

- `agents.defaults.model` must be `{ "primary": "model/name" }` not a string
- `gateway.mode` must be `"local"` for headless operation
- No `webchat` channel - the Control UI is served automatically
- `gateway.bind` is not a config option - use `--bind` CLI flag

See [OpenClaw docs](https://docs.openclaw.ai/) for full schema.

## Common Tasks

### Adding a New API Endpoint

1. Add route handler in `src/routes/api.ts`
2. Add types if needed in `src/types.ts`
3. Update client API in `src/client/api.ts` if frontend needs it
4. Add tests

### Adding a New Environment Variable

1. Add to `MoltbotEnv` interface in `src/types.ts`
2. If passed to container, add to `buildEnvVars()` in `src/gateway/env.ts`
3. Update `.dev.vars.example`
4. Document in README.md secrets table

### Debugging

```bash
# View live logs
npx wrangler tail

# Check secrets
npx wrangler secret list
```

Enable debug routes with `DEBUG_ROUTES=true` and check `/debug/processes`.

## R2 Storage Notes

Persistence lives in `src/persistence.ts` and runs from the Worker, not the container. `/home/openclaw` (HOME; `/root/.openclaw` and `/root/clawd` symlink into it) is backed up with `sandbox.createBackup()` squashfs snapshots. Handles are stored newest-first in `backup-handles.json` (the newest is mirrored to legacy `backup-handle.json`) and the last 3 are kept. Snapshots are pruned by count, so their TTL is set long (90 days) and only matters if scheduled backups stop.

Gotchas:

- **Restore order**: newest snapshot → older snapshots (if expired/not found). Transient restore errors are rethrown rather than falling back, so a temporary failure never rolls state back. If every snapshot is gone the container starts fresh; the expired objects stay in R2 under `backups/<id>/`.
- **Restore marker**: after a successful restore (or when R2 has no backups) the Worker writes `/tmp/moltworker-state-ok` in the container. `/tmp` is wiped on container restart. `isSafeToBackup()` requires this marker, so a container running with empty state never overwrites good backups. `POST /api/admin/storage/sync?force=true` bypasses it.
- **Restore only before starting the gateway**: `restoreBackup()` unmounts and remounts `/home/openclaw` as a FUSE overlay; doing that under a running gateway rolls its state back and detaches its later writes from backups. `restoreIfNeeded` is only called from `ensureStarted`, with no gateway running, and skips containers that already have the restore marker (not a per-isolate flag — isolates are recycled independently of the container). A failed restore aborts startup rather than starting a blank gateway.
- **createBackup is non-destructive**: it runs `mksquashfs` on the merged overlay view. It is safe while the gateway runs; partially written files may be inconsistent.
- **Expired snapshots are not deleted by the SDK**: `createSnapshot` deletes pruned snapshots' R2 objects itself.
- **Automatic backups** run from the cron trigger (`src/cron/backup.ts`) only when `SANDBOX_SLEEP_AFTER=never`, because the RPCs would keep a sleeping container awake. An R2 lock (`backup-lock`) prevents overlap, and `backup-state.json` records the last attempt so failures retry after one interval rather than every minute.
- **Credentials**: the SDK needs `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_ACCOUNT_ID` and `BACKUP_BUCKET_NAME` to create presigned URLs. `BACKUP_BUCKET_NAME` has no default.
- **Process status**: The sandbox API's `proc.status` may not update immediately after a process completes. Instead of checking `proc.status === 'completed'`, verify success by checking for expected output.
- **Cron store**: `cron/wake.ts` reads `openclaw/cron/jobs.json` from R2, but nothing currently writes it (the container-side sync that did was removed), so wake-ahead is inactive.
