# Fourier — Auth (Matrix-Gated Media Proxy) Dev Log

**Project:** Fourier · **Component:** Auth (platform-gated media auth & token broker)
**Location:** `/opt/fourier/auth/`
**Status:** Core service built and proven end to end on the host. Not yet containerized;
Danbooru integration not yet wired.

---

## 1. Purpose

fourier-auth gates access to media so that only users who can prove a valid Matrix
identity — and who have permission in Matrix to see a given image — can retrieve it. It
exists to close the gap that the booru currently serves media openly (`/data/` static
files, no auth).

The design principle driving it: **Danbooru stores metadata and a pointer (the MXC URI),
not the media bytes.** All image bytes live in Synapse's R2 and are served through this
auth proxy, which enforces the viewer's Matrix permissions on every request. Synapse
remains the single authority for both storage and authorization.

---

## 2. Architecture

Browser (booru page) sends GET /media/<server>/<mediaId>?thumb=1 carrying the
fourier_session cookie. fourier-auth resolves the session cookie to a Matrix token via
fourier-redis, then calls the Synapse authenticated media API with that token. Synapse
enforces that the token is valid AND the user shares the room the media is in, returning
the image bytes (streamed back) or 401/403 if not permitted.

Key property: the Matrix token is **never** exposed to the browser. The browser only ever
holds an opaque session id (cookie); the token lives server-side in Redis.

### Provider seam (future-proofing)

Login is structured behind a **provider interface** (providers.js). A provider
authenticates a user and yields { matrixUserId, matrixToken }. Matrix (password grant)
is the first and currently only provider. Future providers (SSO/OIDC, other platforms)
implement the same shape, so the session and gate layers never need to know which provider
was used. This keeps the architecture dynamic for Fourier's planned multi-platform growth.

---

## 3. Files

All under /opt/fourier/auth/:

- index.js — Express app: /healthz, /login, /logout, and the /media/... proxy gate
- session.js — Redis-backed sessions: create, resolve, destroy; opaque id -> Matrix token
- providers.js — Provider interface + MatrixProvider (password grant against Synapse /login)
- redis/docker-compose.yaml — Dedicated fourier-redis (ephemeral, capped, loopback-only in dev)
- DEPENDENCIES.md — Cross-cutting version/dependency manifest for the whole stack
- package.json / package-lock.json — Node deps: express, ioredis, axios, cookie-parser

---

## 4. Sessions

- Opaque session id = 32 random bytes (crypto.randomBytes), unguessable.
- Stored in Redis as session:<id> -> { matrixUserId, matrixToken, createdAt }.
- TTL: 24h default (SESSION_TTL), auto-expiring in Redis.
- The browser cookie (fourier_session) is httpOnly, sameSite=lax.
- Logout (/logout) deletes the Redis key and clears the cookie — proven to immediately
  revoke media access.

### fourier-redis

- redis:7-alpine, dedicated instance, its own fourier-redis_net network.
- Ephemeral: persistence disabled (--save "" --appendonly no). A restart logs everyone
  out (acceptable) and avoids storing Matrix tokens on disk.
- Capped: --maxmemory 256mb --maxmemory-policy allkeys-lru.
- Not host-published in production — only a loopback port (127.0.0.1:6379) for host-based
  dev. Remove/keep loopback-only once auth is containerized.

---

## 5. Login (current: Matrix password grant)

- POST /login with { provider?: "matrix", username, password }.
- MatrixProvider calls Synapse /_matrix/client/v3/login (m.login.password), with
  initial_device_display_name "Fourier" so these sessions are identifiable in the user's
  Matrix device list.
- On success: returns { matrixUserId, matrixToken, deviceId }, a session is minted, the
  cookie is set.
- On failure: Synapse's error is passed through as 401.

**Acknowledged limitation:** the user types their Matrix password into a Fourier form,
which means Fourier sees it in transit (not stored). Acceptable for trusted/admin users;
to be replaced by an SSO/OIDC provider before opening to general users.

---

## 6. What was proven (host testing)

All tested on the host against the live Synapse and fourier-redis:

- Valid login -> session -> thumbnail fetch: 200, correct JPEG.
- Valid session -> full image fetch: 200.
- Synapse thumbnail endpoint confirmed working and auth-gated (the design hinge — means
  no resizer needs building; Synapse generates thumbnails).
- Security guarantees verified:
  - No cookie -> 401
  - Bogus session id -> 401
  - Valid session but invalid underlying token -> 401 (Synapse refuses)
  - Wrong password -> 401, no session minted
  - After logout, previously-valid session -> 401

---

## 7. Deferred / what's next

1. Wire Danbooru's image URLs to the gate (Step 5). The remaining integration. Requires
   modifying Danbooru's OpenResty config so /data/ (currently open static files mapped to
   /images/) routes through fourier-auth instead, and rewriting how Danbooru renders image
   URLs to point at the gate keyed by MXC. Most invasive part — modifies third-party
   software, not Fourier's own code.
2. Containerize fourier-auth. Dockerfile (Node 22) + compose, joining Synapse's network
   and fourier-redis_net. Same arc as bmb. Currently runs only on the host.
3. Device cleanup on logout/expiry. Every login creates a new Matrix device. Logout (and
   ideally session expiry) should call Synapse logout to invalidate that device/token, or
   the user's device list accumulates "Fourier" entries indefinitely.
4. Remove the loopback Redis port once auth is containerized and reaches Redis over the
   internal network.
5. SSO/OIDC provider. Replaces password-grant for general users; slots in behind the
   existing provider seam without touching session/gate code.
6. Map post -> MXC at request time. The gate currently takes server/mediaId directly; the
   Danbooru integration needs to resolve a booru post to its MXC and produce gate URLs.

---

## 8. Operational reference

Auth service (host dev):
  cd /opt/fourier/auth
  SYNAPSE_URL="http://127.0.0.1:8008" REDIS_URL="redis://127.0.0.1:6379" PORT=8010 node index.js

fourier-redis:
  cd /opt/fourier/auth/redis
  docker compose up -d
  docker compose ps

Health:
  curl -s http://127.0.0.1:8010/healthz   (-> {"status":"ok","redis":true})

- Synapse authenticated media endpoints used:
  /_matrix/client/v1/media/download/<server>/<id> and .../thumbnail/<server>/<id>
- Session cookie: fourier_session (httpOnly)
- Default ports: auth 8010 (dev), redis 6379 (loopback dev only)

---

Development log for the fourier-auth build.
