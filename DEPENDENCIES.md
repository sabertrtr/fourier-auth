# Fourier — Dependency & Version Manifest

This document records the **deliberate** version choices and constraints across the
Fourier stack and the services it integrates with. It is **not** an exhaustive dependency
list — `package-lock.json` already pins the full resolved npm tree for Node services. This
file captures *decisions and constraints*: where a version is pinned for a specific reason,
that reason is recorded here so it is not lost or accidentally "upgraded" away.

Update this file whenever a version choice changes or a new constrained dependency is added.

Last verified: 2026-06-11.

---

## Fourier services

### fourier-bmb (Booru-Matrix Bridge)

- **Location:** `/opt/fourier/bmb/`
- **Runtime base image:** `node:20-slim` — running **Node v20.20.2**
  - **Why pinned to Node 20 (NOT 22/24):** `matrix-appservice-bridge` depends transitively
    on `nedb@^1.8.0`, which calls `util.isDate()`. That API was removed in Node 22+, causing
    a hard crash (`TypeError: util.isDate is not a function`) the moment the bridge writes to
    its datastore. Node 20 is the practical ceiling until the appservice library drops nedb.
  - **Forward risk:** Node 20 security support ends ~April 2026. Migration path is a newer
    appservice library without nedb, not bumping the Node version.
- **Key direct dependencies (from package.json):**
  | Package | Version | Constraint reason |
  |---------|---------|-------------------|
  | `matrix-appservice-bridge` | `^11.2.0` | Core appservice framework. Pulls in `nedb` (the Node-20 constraint above). |
  | `axios` | `^1.17.0` | HTTP client for Synapse + Danbooru calls. No special constraint. |
  | `js-yaml` | `^4.2.0` | Config + registration parsing. No special constraint. |
  | `form-data` | `^4.0.5` | Multipart upload of image bytes to Danbooru. No special constraint. |
- **Full resolved tree:** see `package-lock.json` (authoritative; do not duplicate here).

### fourier-auth (Matrix-gated media auth/token broker) — IN PROGRESS

- **Location:** `/opt/fourier/auth/` (planned)
- **Runtime base image:** `node:22-slim` (current LTS).
  - **Why Node 22, not 20 (unlike bmb):** fourier-auth does NOT use matrix-appservice-bridge,
    so it has no `nedb`/`util.isDate` constraint. Confirmed clean install (0 vulnerabilities,
    no nedb in tree). Started on current LTS deliberately rather than inheriting bmb's
    EOL-sooner Node 20. Divergence from bmb is intentional and documented.
- **Dedicated Redis:** `fourier-redis` at `/opt/fourier/redis/` (separate from Danbooru's
  Redis by design — maximum isolation; no shared key namespace or lifecycle coupling).
  - **Image:** `redis:7-alpine` (pinned to major 7, NOT floating `latest`).
  - **Ephemeral by design:** persistence disabled (`--save "" --appendonly no`); a restart
    clears sessions and users simply re-login. Avoids storing Matrix tokens on disk.
  - **Capped:** `--maxmemory 256mb --maxmemory-policy allkeys-lru` so the session store
    cannot exhaust host RAM.
  - **Not host-published in prod:** only a loopback port (`127.0.0.1:6379`) for host-based
    dev; isolated on its own `fourier-redis_net` network otherwise.
- **npm deps (clean tree, 0 vulnerabilities, no nedb):** express, ioredis, axios, cookie-parser.

---

## Integrated services (not part of Fourier, but Fourier depends on their behavior)

### Synapse (Matrix homeserver)

- **Location:** `/opt/synapse/` — built locally (`build: .`), not a pulled image.
- **Version:** **Synapse 1.152.1**
- **Relevant config constraints:**
  - `enable_authenticated_media: true` — REQUIRED. Fourier's media-gating model relies on
    Synapse enforcing auth on media; with this on, an exposed MXC URI is not a leak vector.
  - Default prejoin (stripped) state includes `m.room.power_levels` — BMB's invite fast-path
    depends on this. (Synapse default; do not override `room_prejoin_state` to exclude it.)
  - Authenticated media endpoints in use: `/_matrix/client/v1/media/download/...` and
    `/_matrix/client/v1/media/thumbnail/...` (the latter confirmed working for fourier-auth's
    thumbnail-serving design — returns resized JPEG, auth-gated).

### Postgres (Synapse's database)

- **Image:** `postgres:16` (stock).
- Note: this is a **different** image from Danbooru's Postgres (below). Deliberate, not an
  inconsistency to "fix" — each stack owns its own DB.

### Danbooru stack

- **App / cron / jobs / nginx:** `ghcr.io/danbooru/danbooru:production` — **floating tag**
  (tracks `production`, not a fixed version). Actual running version drifts on pull.
- **Postgres:** `ghcr.io/danbooru/postgres:16.1` — Danbooru's customized Postgres image,
  pinned to 16.1. Distinct from Synapse's stock `postgres:16`.
- **Autotagger:** `ghcr.io/danbooru/autotagger:latest` — **floating tag.** Reachable on the
  `danbooru_default` network as `autotagger:5000`. Invoked automatically by Danbooru during
  upload processing (BMB does not call it directly).
- **Redis:** `redis` — **floating tag** (no version pin). Danbooru's own Redis; separate
  from the planned `fourier-redis`.
- **IQDB:** `evazion/iqdb` — **floating tag.**
- **Archives:** `ghcr.io/danbooru/archives:latest` — **floating tag.**
- **SQS (local):** `softwaremill/elasticmq-native` — **floating tag.**
- **Element web:** `vectorim/element-web:latest` — **floating tag.**

#### Danbooru storage / runtime notes
- Danbooru runs as **uid 1000** inside its containers. The `/images` bind mount
  (`/mnt/storage/danbooru-images` on the host) must be owned by uid 1000 or variant writes
  fail with `Permission denied @ dir_s_mkdir`. On the host, uid 1000 = `saber`.
- Danbooru serves media via **OpenResty** (nginx + Lua), config at
  `/danbooru/config/nginx.conf`. The `/data/` location maps to `/images/` and is currently
  served as **open static files (no auth)** — this is the gap fourier-auth is being built to
  close.
- Danbooru API specifics relied on by BMB: multipart upload field `upload[files][0]`; post
  creation requires `upload_media_asset_id` at the top level (not `media_asset_id`) plus a
  mandatory `rating`.

---

## Floating-tag risk register

The following are NOT version-pinned and can change on `docker compose pull`. If
reproducibility or stability becomes a concern, pin these to image digests:

- `vectorim/element-web:latest`
- `redis` (Danbooru's)
- `ghcr.io/danbooru/danbooru:production`
- `ghcr.io/danbooru/autotagger:latest`
- `ghcr.io/danbooru/archives:latest`
- `evazion/iqdb`
- `softwaremill/elasticmq-native`

---

## Verified versions snapshot (2026-06-11)

| Component | Version |
|-----------|---------|
| Synapse | 1.152.1 |
| Node (bmb container) | v20.20.2 |
| Synapse Postgres | 16 (stock image) |
| Danbooru Postgres | 16.1 (danbooru image) |
