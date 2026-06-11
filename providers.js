const axios = require("axios");

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";

// --- Provider interface ---------------------------------------------------
// A provider authenticates a user and yields { matrixUserId, matrixToken }.
// Future providers (SSO/OIDC, other platforms) implement the same shape so the
// session/gate layers never need to know which provider was used.
//
//   async login(credentials) -> { matrixUserId, matrixToken, deviceId }
//   (throws on failure)
// --------------------------------------------------------------------------

// MatrixProvider: direct password grant (m.login.password).
// NOTE: this collects the user's Matrix password via Fourier. Acceptable for
// trusted/admin users; to be superseded by an SSO provider for public users.
const MatrixProvider = {
  name: "matrix",

  async login({ username, password }) {
    if (!username || !password) {
      const e = new Error("username and password required");
      e.status = 400;
      throw e;
    }

    let resp;
    try {
      resp = await axios.post(
        `${SYNAPSE_URL}/_matrix/client/v3/login`,
        {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: username },
          password: password,
          initial_device_display_name: "Fourier",
        },
        { validateStatus: () => true }
      );
    } catch (err) {
      const e = new Error("could not reach homeserver");
      e.status = 502;
      throw e;
    }

    if (resp.status !== 200) {
      const e = new Error(
        (resp.data && resp.data.error) || "login failed"
      );
      e.status = 401;
      throw e;
    }

    return {
      matrixUserId: resp.data.user_id,
      matrixToken: resp.data.access_token,
      deviceId: resp.data.device_id,
    };
  },
};

// Registry of available providers, keyed by name.
const providers = {
  matrix: MatrixProvider,
};

function getProvider(name) {
  return providers[name] || null;
}

module.exports = { getProvider, providers };
