const Redis = require("ioredis");
const crypto = require("crypto");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(REDIS_URL);

// Redis connection error handler.
//
// EXPECTED TRANSIENT ERROR DURING SETUP:
// If you load this module directly on the HOST before the service is
// containerized (e.g. `node -e "require('./session.js')"` or any host-side
// load test), ioredis will try to reach REDIS_URL's default of
// 127.0.0.1:6379 and fail with repeated ECONNREFUSED, because fourier-redis
// is internal to the Docker network and is NOT published to the host. This
// is the expected outcome of that transient state, not a real fault: the
// module has still loaded correctly. In the running container REDIS_URL is
// redis://fourier-redis:6379, which resolves over fourier-redis_net and
// connects on the first attempt, so this path is never exercised in
// production. (To load-test on the host without any connection attempt at
// all, use `node --check session.js`, which parses without executing.)
//
// Handling the event also prevents Node's "Unhandled error event" stack-
// trace spam and is the correct way to run ioredis in production, where the
// ephemeral Redis is *designed* to be restarted (which briefly drops the
// connection and triggers an automatic reconnect).
redis.on("error", (err) => {
  console.error("[redis] connection error:", err.code || err.message);
});

// Session lifetime (seconds). Sessions auto-expire in Redis.
const SESSION_TTL = parseInt(process.env.SESSION_TTL || "86400", 10); // 24h

const KEY_PREFIX = "session:";

// Create a session for a resolved Matrix identity.
// Stores the token server-side; returns the opaque session id for the cookie.
async function createSession({ matrixUserId, matrixToken }) {
  const sid = crypto.randomBytes(32).toString("hex");
  const payload = JSON.stringify({
    matrixUserId,
    matrixToken,
    createdAt: Date.now(),
  });
  await redis.set(KEY_PREFIX + sid, payload, "EX", SESSION_TTL);
  return sid;
}

// Resolve a session id to its stored data, or null if missing/expired.
async function getSession(sid) {
  if (!sid) return null;
  const raw = await redis.get(KEY_PREFIX + sid);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Destroy a session (logout).
async function destroySession(sid) {
  if (!sid) return;
  await redis.del(KEY_PREFIX + sid);
}

// For health checks: confirm Redis connectivity.
async function redisPing() {
  return redis.ping();
}

// Generic short-lived JSON cache (used by the media-auth gate). Reuses the same
// redis connection as sessions. get returns the parsed value or null; set stores
// with a TTL in seconds.
async function cacheGetJson(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function cacheSetJson(key, value, ttlSeconds) {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

// Short-lived storage for in-flight OIDC login state (PKCE verifier + CSRF
// state), keyed by the random state value. Separate from sessions; 10-min TTL.
const OIDC_PREFIX = "oidc:";
async function putOidcState(state, data, ttlSeconds = 600) {
  await redis.set(OIDC_PREFIX + state, JSON.stringify(data), "EX", ttlSeconds);
}
async function takeOidcState(state) {
  if (!state) return null;
  const raw = await redis.get(OIDC_PREFIX + state);
  if (!raw) return null;
  await redis.del(OIDC_PREFIX + state); // single-use
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = { createSession, getSession, destroySession, redisPing, putOidcState, takeOidcState, cacheGetJson, cacheSetJson };
