const Redis = require("ioredis");
const crypto = require("crypto");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(REDIS_URL);

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

module.exports = { createSession, getSession, destroySession, redisPing };
