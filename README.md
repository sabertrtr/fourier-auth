# Fourier — Auth

Platform-gated media authorization and token broker for the Fourier project.

fourier-auth gates access to media so that only users who can prove a valid Matrix identity
— and who have permission in Matrix to see a given image — can retrieve it. It is the
access-control layer that lets a metadata store (e.g. Danbooru) reference media without
storing or exposing the bytes: all media is served through this proxy, which enforces the
viewer's Matrix permissions on every request via Synapse's authenticated media API.

Fourier is an umbrella project for targeted data aggregation, classification, and storage.
Auth is one component; see also fourier-bmb (the Booru-Matrix Bridge).

---

## How it works

1. A user logs in by proving a Matrix identity. A server-side session is created in Redis
   mapping an opaque session id (the browser's cookie) to the user's Matrix access token.
2. When the user requests an image, the browser sends only the session cookie.
3. fourier-auth resolves the cookie to the Matrix token (server-side; the token is never
   exposed to the browser) and calls Synapse's authenticated media API with it.
4. Synapse enforces that the token is valid and that the user shares the room the media is
   in, returning the bytes or refusing (401/403). The proxy streams the result back.

Synapse remains the single authority for both storage and authorization. An exposed MXC URI
is only a pointer; it grants no access without a valid, permitted Matrix token.

---

## Status

Proven end to end on the host (login, sessions, gated media fetch, all denial paths). NOT
yet containerized, and not yet integrated with a consuming application (e.g. Danbooru's
image rendering). See DEVLOG.md for the full state and the deferred roadmap.

---

## Requirements

- A working Synapse homeserver with enable_authenticated_media: true.
- Redis (a dedicated, ephemeral instance is provided under redis/).
- Node 22 (no nedb-class constraint; unlike fourier-bmb this is not pinned to Node 20).

---

## Configuration (environment variables)

- SYNAPSE_URL — base URL of the homeserver (e.g. http://synapse:8008).
- REDIS_URL — e.g. redis://fourier-redis:6379 (or redis://127.0.0.1:6379 for host dev).
- PORT — listen port (default 8010).
- SESSION_TTL — session lifetime in seconds (default 86400).

---

## Running (host / development)

Start the dedicated Redis:

    cd redis
    docker compose up -d

Start the service:

    SYNAPSE_URL="http://127.0.0.1:8008" REDIS_URL="redis://127.0.0.1:6379" PORT=8010 node index.js

Health check:

    curl -s http://127.0.0.1:8010/healthz

---

## API

- POST /login — body { provider?: "matrix", username, password }. Authenticates via the
  named provider (default "matrix") and sets the session cookie.
- POST /logout — destroys the session and clears the cookie.
- GET /media/<server>/<mediaId> — proxies the full image (auth required).
- GET /media/<server>/<mediaId>?thumb=1 — proxies a thumbnail (auth required).
- GET /healthz — service + Redis health.

---

## Providers

Login is structured behind a provider interface (providers.js). A provider authenticates a
user and yields { matrixUserId, matrixToken }. Matrix (password grant) is the first and
currently only provider. Additional providers (SSO/OIDC, other platforms) implement the same
shape without changes to the session or gate layers.

The current Matrix provider uses a direct password grant, which means the user's Matrix
password is submitted to fourier-auth (in transit, not stored). This is acceptable for
trusted/admin users and is intended to be superseded by an SSO/OIDC provider before opening
to general users.

---

## Security notes

- Matrix tokens are stored server-side in Redis, never exposed to the browser.
- fourier-redis is ephemeral (no disk persistence) so tokens are not written to disk; a
  restart simply logs users out.
- The session cookie is httpOnly.
- Authenticated media must be enabled on Synapse for the gating model to hold.

---

## Credits

Code written by Claude (Anthropic). The human counterpart paid the electric bill and
asked the right questions.

---

## License

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See LICENSE.

If you run a modified version of this software as a network service, the AGPL requires you to
make your modified source available to its users. The copyright holder may also offer
commercial licensing terms separately.
