const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const { createSession, getSession, destroySession, redisPing,
        putOidcState, takeOidcState } = require("./session");
const { getProvider } = require("./providers");

const app = express();
app.use(cookieParser());
app.use(express.json());

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";
const PORT = process.env.PORT || 8010;
const COOKIE_NAME = "fourier_session";
const POST_LOGIN_REDIRECT = process.env.POST_LOGIN_REDIRECT || "https://booru.41chan.net/";

// Thumbnail sizes the gate will request from Synapse. Requested ?w=/?h=
// values are snapped to the nearest entry so callers can't induce
// arbitrary-size thumbnail generation.
const ALLOWED_THUMB_SIZES = [180, 320, 360, 720, 850];

// Health check (also verifies Redis connectivity)
app.get("/healthz", async (req, res) => {
  let redisOk = false;
  try { redisOk = (await redisPing()) === "PONG"; } catch (e) {}
  res.json({ status: "ok", service: "fourier-auth", redis: redisOk });
});

// Login: begin the OIDC Authorization Code flow. Redirects the browser to
// MAS. State + PKCE verifier are stashed in Redis (single-use, short TTL).
app.get("/login", async (req, res) => {
  const provider = getProvider("oidc");
  try {
    const { url, state, codeVerifier } = await provider.authUrl();
    await putOidcState(state, { codeVerifier });
    res.redirect(url);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// OIDC redirect target: MAS sends the user back here with code + state.
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).json({ error: "missing code or state" });
  }
  const stored = await takeOidcState(state);
  if (!stored) {
    return res.status(400).json({ error: "unknown or expired state" });
  }
  try {
    const provider = getProvider("oidc");
    const identity = await provider.exchange({
      code,
      codeVerifier: stored.codeVerifier,
    });
    const sid = await createSession({
      matrixUserId: identity.matrixUserId,
      matrixToken: identity.matrixToken,
    });
    res.cookie(COOKIE_NAME, sid, { httpOnly: true, sameSite: "lax" });
    res.redirect(POST_LOGIN_REDIRECT);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Logout
app.post("/logout", async (req, res) => {
  await destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// Media proxy: resolves the caller's session -> Matrix token, streams from Synapse.
// Thumbnails: ?w=<px>&h=<px> (snapped to ALLOWED_THUMB_SIZES), or legacy ?thumb=1 (320).
app.get("/media/:serverName/:mediaId", async (req, res) => {
  const { serverName, mediaId } = req.params;

  let thumbSize = null;
  if (req.query.w || req.query.h) {
    const want = parseInt(req.query.w || req.query.h, 10) || 320;
    thumbSize = ALLOWED_THUMB_SIZES.reduce((a, b) =>
      Math.abs(b - want) < Math.abs(a - want) ? b : a);
  } else if (req.query.thumb === "1") {
    thumbSize = 320;
  }

  const session = await getSession(req.cookies[COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ error: "no valid session" });
  }
  const token = session.matrixToken;

  const base = `${SYNAPSE_URL}/_matrix/client/v1/media`;
  const url = thumbSize
    ? `${base}/thumbnail/${serverName}/${mediaId}?width=${thumbSize}&height=${thumbSize}&method=scale`
    : `${base}/download/${serverName}/${mediaId}`;

  try {
    const upstream = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
      validateStatus: () => true,
    });
    if (upstream.status !== 200) {
      return res.status(upstream.status).json({
        error: "synapse refused media request",
        status: upstream.status,
      });
    }
    if (upstream.headers["content-type"]) {
      res.set("Content-Type", upstream.headers["content-type"]);
    }
    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: "upstream error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`fourier-auth listening on port ${PORT}`);
});
