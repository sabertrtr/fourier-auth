const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const { createSession, getSession, destroySession, redisPing } = require("./session");
const { getProvider } = require("./providers");

const app = express();
app.use(cookieParser());
app.use(express.json());

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";
const PORT = process.env.PORT || 8010;
const COOKIE_NAME = "fourier_session";

// Health check (also verifies Redis connectivity)
app.get("/healthz", async (req, res) => {
  let redisOk = false;
  try { redisOk = (await redisPing()) === "PONG"; } catch (e) {}
  res.json({ status: "ok", service: "fourier-auth", redis: redisOk });
});

// Login: authenticate via a provider, mint a session.
// Body: { provider?: "matrix", username, password }
app.post("/login", async (req, res) => {
  const { provider: providerName = "matrix", ...credentials } = req.body || {};
  const provider = getProvider(providerName);
  if (!provider) {
    return res.status(400).json({ error: `unknown provider: ${providerName}` });
  }
  try {
    const identity = await provider.login(credentials);
    const sid = await createSession({
      matrixUserId: identity.matrixUserId,
      matrixToken: identity.matrixToken,
    });
    res.cookie(COOKIE_NAME, sid, { httpOnly: true, sameSite: "lax" });
    res.json({ ok: true, user: identity.matrixUserId });
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
app.get("/media/:serverName/:mediaId", async (req, res) => {
  const { serverName, mediaId } = req.params;
  const wantThumb = req.query.thumb === "1";

  const session = await getSession(req.cookies[COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ error: "no valid session" });
  }
  const token = session.matrixToken;

  const base = `${SYNAPSE_URL}/_matrix/client/v1/media`;
  const url = wantThumb
    ? `${base}/thumbnail/${serverName}/${mediaId}?width=320&height=320&method=scale`
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
