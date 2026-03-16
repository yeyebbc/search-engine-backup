const DROPBOX_CONTENT_API = "https://content.dropboxapi.com/2";
const BACKUP_PATH = "/firefox_search_backup.json";

// ─── i18n & UI Helpers ──────────────────────────────────────────────────────

function t(key, ...subs) {
  return browser.i18n.getMessage(key, subs) || key;
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
});

function showMessage(text, type = "info") {
  const box = document.getElementById("message-box");
  box.textContent = text;
  box.className = type;
}

// ─── MozLz4 Parsing & Backup Flow ───────────────────────────────────────────

document
  .getElementById("mozlz4-input")
  .addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    showMessage(t("msgParsingFile"), "info");

    try {
      // 1. Parse MozLz4
      const text = await parseMozLz4(file);
      const json = JSON.parse(text);
      const { engine_urls = {} } =
        await browser.storage.local.get("engine_urls");

      let foundCount = 0;
      if (json.engines) {
        for (const eng of json.engines) {
          const url = extractTemplateUrl(eng);
          if (url && eng._name) {
            engine_urls[eng._name] = url;
            foundCount++;
          }
        }
        await browser.storage.local.set({ engine_urls });
      }

      // 2. Upload to Dropbox
      showMessage(t("msgBackingUp"), "info");
      const token = await getToken();
      const engines = await browser.search.get();

      const payload = {
        version: "1.0",
        backupDate: new Date().toISOString(),
        defaultEngine: engines.find((e) => e.isDefault)?.name || null,
        engines: engines.map((e) => ({
          name: e.name,
          alias: e.alias || null,
          favIconUrl: e.favIconUrl || null,
          isDefault: e.isDefault,
          searchUrl: engine_urls[e.name] || null,
        })),
      };

      await uploadToDropbox(token, payload);
      showMessage(
        t(
          "msgBackupSuccess",
          String(payload.engines.length),
          new Date().toLocaleTimeString(),
        ),
        "success",
      );
    } catch (err) {
      showMessage(t("msgFileParseError", err.message), "error");
    }
  });

function extractTemplateUrl(engineData) {
  if (!engineData._urls || !engineData._urls.length) return null;
  const urlObj =
    engineData._urls.find((u) => u.type === "text/html") || engineData._urls[0];
  if (!urlObj.template) return null;

  let url = urlObj.template;
  if (urlObj.params && urlObj.params.length > 0) {
    const query = urlObj.params
      .filter((p) => p.name && p.value !== undefined)
      .map(
        (p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`,
      )
      .join("&");
    if (query) url += (url.includes("?") ? "&" : "?") + query;
  }
  return url.replace(/%7B(.*?)%7D/g, "{$1}");
}

async function parseMozLz4(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);

  if (new TextDecoder().decode(u8.subarray(0, 8)) !== "mozLz40\0") {
    throw new Error("Invalid signature (not a Firefox mozlz4 file)");
  }

  const uncompressedSize = new DataView(buf).getUint32(8, true);
  const decompressed = decompressLz4Block(u8.subarray(12), uncompressedSize);
  return new TextDecoder().decode(decompressed);
}

function decompressLz4Block(input, uncompressedSize) {
  const output = new Uint8Array(uncompressedSize);
  let i = 0,
    o = 0;

  while (i < input.length) {
    const token = input[i++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let l;
      do {
        l = input[i++];
        litLen += l;
      } while (l === 255);
    }
    if (i + litLen > input.length || o + litLen > output.length)
      throw new Error("LZ4 literal copy out of bounds");
    for (let j = 0; j < litLen; j++) output[o++] = input[i++];
    if (i >= input.length) break;

    const offset = input[i++] | (input[i++] << 8);
    if (offset === 0) throw new Error("Invalid LZ4 match offset");

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let l;
      do {
        l = input[i++];
        matchLen += l;
      } while (l === 255);
    }
    matchLen += 4;
    if (o + matchLen > output.length)
      throw new Error("LZ4 match copy out of bounds");

    const matchPos = o - offset;
    for (let j = 0; j < matchLen; j++) output[o++] = output[matchPos + j];
  }
  return output;
}

// ─── Dropbox Utilities ──────────────────────────────────────────────────────

async function getToken() {
  const { dropbox_access_token, dropbox_refresh_token, dropbox_token_expiry } =
    await browser.storage.local.get([
      "dropbox_access_token",
      "dropbox_refresh_token",
      "dropbox_token_expiry",
    ]);
  if (!dropbox_access_token) throw new Error("Not connected to Dropbox");
  if (dropbox_token_expiry && Date.now() > dropbox_token_expiry - 300_000) {
    return await refreshToken(dropbox_refresh_token);
  }
  return dropbox_access_token;
}

async function refreshToken(refreshToken) {
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID, // <--- Set your App Key here
    }),
  });
  const data = await res.json();
  await browser.storage.local.set({
    dropbox_access_token: data.access_token,
    dropbox_token_expiry: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

async function uploadToDropbox(token, payload) {
  const res = await fetch(`${DROPBOX_CONTENT_API}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: BACKUP_PATH,
        mode: "overwrite",
        mute: false,
      }),
    },
    body: JSON.stringify(payload, null, 2),
  });
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}
