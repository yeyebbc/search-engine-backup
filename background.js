const CLIENT_ID = EXTENSION_CONFIG.dropboxAppKey;

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "authenticate") return handleOAuth();
  if (msg.action === "disconnect") return revokeToken();
});

// ─── OAuth 2.0 PKCE Flow ────────────────────────────────────────────────────

async function handleOAuth() {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const redirectUri = browser.identity.getRedirectURL();
  const state = generateVerifier(16);

  await browser.storage.local.set({
    _pkce_verifier: verifier,
    _oauth_state: state,
  });

  const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("token_access_type", "offline");

  try {
    const responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });

    const params = new URL(responseUrl).searchParams;
    const code = params.get("code");
    const retState = params.get("state");

    const { _pkce_verifier, _oauth_state } = await browser.storage.local.get([
      "_pkce_verifier",
      "_oauth_state",
    ]);

    if (retState !== _oauth_state)
      throw new Error("State mismatch — possible CSRF");

    const tokens = await exchangeCode(code, _pkce_verifier, redirectUri);

    await browser.storage.local.set({
      dropbox_access_token: tokens.access_token,
      dropbox_refresh_token: tokens.refresh_token,
      dropbox_token_expiry: Date.now() + tokens.expires_in * 1000,
    });
    await browser.storage.local.remove(["_pkce_verifier", "_oauth_state"]);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function exchangeCode(code, verifier, redirectUri) {
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const e = await res.json();
    const body = await res.text(); // read as text — body IS the error message for 400s
    console.error("Token exchange error:", body);
    throw new Error(body);
    // throw new Error(e.error_description || "Token exchange failed");
  }
  return res.json();
}

async function revokeToken() {
  const { dropbox_access_token } = await browser.storage.local.get(
    "dropbox_access_token"
  );
  if (dropbox_access_token) {
    await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${dropbox_access_token}` },
    }).catch(() => {});
  }
  await browser.storage.local.remove([
    "dropbox_access_token",
    "dropbox_refresh_token",
    "dropbox_token_expiry",
  ]);
  return { success: true };
}

// ─── PKCE Helpers ───────────────────────────────────────────────────────────

function generateVerifier(length = 32) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

async function generateChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

function base64url(arr) {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
