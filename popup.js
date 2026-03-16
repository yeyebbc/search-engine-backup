const DROPBOX_CONTENT_API = "https://content.dropboxapi.com/2";
const BACKUP_PATH = "/firefox_search_backup.json";

// ─── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  applyI18n();

  await checkAuthState();
  await loadEngines();

  document
    .getElementById("auth-btn")
    .addEventListener("click", handleAuthClick);
  // Backup button listener
  document.getElementById("backup-btn").addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("backup.html") });
  });
  // Listen for file selection
  document
    .getElementById("mozlz4-input")
    .addEventListener("change", handleMozlz4Selection);
  document.getElementById("restore-btn").addEventListener("click", doRestore);
  document.getElementById("refresh-btn").addEventListener("click", loadEngines);
});

// ─── MozLz4 File Handling ──────────────────────────────────────────────────
async function handleMozlz4Selection(e) {
  const file = e.target.files[0];
  if (!file) return;

  showMessage(t("msgParsingFile"), "info");
  try {
    const text = await parseMozLz4(file);
    const json = JSON.parse(text);

    const { engine_urls = {} } = await browser.storage.local.get("engine_urls");
    let foundCount = 0;

    // Extract OpenSearch templates and query parameters from JSON
    if (json.engines) {
      for (const eng of json.engines) {
        const url = extractTemplateUrl(eng);
        if (url && eng._name) {
          engine_urls[eng._name] = url;
          foundCount++;
        }
      }

      // Save extracted URLs to local storage and update the UI inputs
      await browser.storage.local.set({ engine_urls });
      await loadEngines();
    }

    showMessage(t("msgParsedSuccess", String(foundCount)), "success");

    // Resume the normal backup to Dropbox
    await doBackup();
  } catch (err) {
    showMessage(t("msgFileParseError", err.message), "error");
  }

  e.target.value = ""; // Reset file input
}

function extractTemplateUrl(engineData) {
  if (!engineData._urls || !engineData._urls.length) return null;

  // Prefer HTML search URLs over suggestions/JSON APIs
  const urlObj =
    engineData._urls.find((u) => u.type === "text/html") || engineData._urls[0];
  if (!urlObj.template) return null;

  let url = urlObj.template;

  // Append query params (e.g., ?q={searchTerms})
  if (urlObj.params && urlObj.params.length > 0) {
    const query = urlObj.params
      .filter((p) => p.name && p.value !== undefined)
      .map(
        (p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`,
      )
      .join("&");

    if (query) {
      url += (url.includes("?") ? "&" : "?") + query;
    }
  }

  // encodeURIComponent turns {searchTerms} into %7BsearchTerms%7D. Revert all {placeholders}.
  return url.replace(/%7B(.*?)%7D/g, "{$1}");
}

async function checkAuthState() {
  const { dropbox_access_token } = await browser.storage.local.get(
    "dropbox_access_token",
  );
  setAuthUI(!!dropbox_access_token);
}

function setAuthUI(connected) {
  const bar = document.getElementById("status-bar");
  const txt = document.getElementById("status-text");
  const btn = document.getElementById("auth-btn");
  const actions = document.getElementById("actions");

  bar.className = `status ${connected ? "connected" : "disconnected"}`;
  txt.textContent = connected ? "✓ Connected to Dropbox" : "Not connected";
  btn.textContent = connected ? "Disconnect" : "Connect Dropbox";
  actions.classList.toggle("hidden", !connected);
}

// ─── Auth ───────────────────────────────────────────────────────────────────

async function handleAuthClick() {
  const { dropbox_access_token } = await browser.storage.local.get(
    "dropbox_access_token",
  );

  if (dropbox_access_token) {
    showMessage("Disconnecting…", "info");
    const res = await browser.runtime.sendMessage({ action: "disconnect" });
    if (res.success) {
      setAuthUI(false);
      showMessage("Disconnected from Dropbox.", "info");
    }
  } else {
    showMessage("Opening Dropbox authorization…", "info");
    const res = await browser.runtime.sendMessage({ action: "authenticate" });
    if (res.success) {
      setAuthUI(true);
      showMessage("Connected to Dropbox!", "success");
    } else {
      showMessage(`Auth failed: ${res.error}`, "error");
    }
  }
}

// ─── Engine List ─────────────────────────────────────────────────────────────

async function loadEngines() {
  const engines = await browser.search.get();
  const { engine_urls = {} } = await browser.storage.local.get("engine_urls");
  const list = document.getElementById("engine-list");
  list.innerHTML = "";

  for (const engine of engines) {
    const card = document.createElement("div");
    card.className = "engine-card";

    const savedUrl = engine_urls[engine.name] || "";

    card.innerHTML = `
      <div class="name">
        ${
          engine.favIconUrl
            ? `<img src="${engine.favIconUrl}" width="14" height="14" alt="">`
            : ""
        }
        ${escHtml(engine.name)}
        ${engine.isDefault ? '<span class="default-badge">Default</span>' : ""}
        ${
          engine.alias
            ? `<span style="color:#888;font-size:11px">${escHtml(
                engine.alias,
              )}</span>`
            : ""
        }
      </div>
      <label>Search URL template (use <code>{searchTerms}</code> as placeholder)</label>
      <input
        type="text"
        data-engine="${escHtml(engine.name)}"
        placeholder="https://example.com/search?q={searchTerms}"
        value="${escHtml(savedUrl)}"
      >
    `;
    list.appendChild(card);
  }

  // Auto-save URL inputs on change
  list.addEventListener("change", async (e) => {
    if (!e.target.dataset.engine) return;
    const { engine_urls = {} } = await browser.storage.local.get("engine_urls");
    engine_urls[e.target.dataset.engine] = e.target.value.trim();
    await browser.storage.local.set({ engine_urls });
  });
}

// ─── Backup ──────────────────────────────────────────────────────────────────

async function doBackup() {
  showMessage("Backing up…", "info");
  try {
    const token = await getToken();
    const engines = await browser.search.get();
    const { engine_urls = {} } = await browser.storage.local.get("engine_urls");

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
      `✓ Backup saved to Dropbox (${
        payload.engines.length
      } engines, ${new Date().toLocaleTimeString()})`,
      "success",
    );
  } catch (err) {
    showMessage(`Backup failed: ${err.message}`, "error");
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

async function doRestore() {
  showMessage("Fetching backup from Dropbox…", "info");
  try {
    const token = await getToken();
    const payload = await downloadFromDropbox(token);

    // Save URLs locally for use in the engine list
    const engine_urls = {};
    for (const e of payload.engines) {
      if (e.searchUrl) engine_urls[e.name] = e.searchUrl;
    }
    await browser.storage.local.set({ engine_urls, last_restore: payload });

    // Open restore helper page
    await browser.tabs.create({
      url: browser.runtime.getURL("restore.html"),
    });

    showMessage(
      `Restore page opened — add ${
        payload.engines.length
      } engines from backup dated ${new Date(
        payload.backupDate,
      ).toLocaleString()}.`,
      "success",
    );
  } catch (err) {
    showMessage(`Restore failed: ${err.message}`, "error");
  }
}

// ─── Dropbox API ─────────────────────────────────────────────────────────────

async function getToken() {
  const { dropbox_access_token, dropbox_refresh_token, dropbox_token_expiry } =
    await browser.storage.local.get([
      "dropbox_access_token",
      "dropbox_refresh_token",
      "dropbox_token_expiry",
    ]);

  if (!dropbox_access_token) throw new Error("Not connected to Dropbox");

  // Refresh if within 5 minutes of expiry
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
      client_id: CLIENT_ID, // ← same as background.js
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
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error_summary || "Upload failed");
  }
  return res.json();
}

async function downloadFromDropbox(token) {
  const res = await fetch(`${DROPBOX_CONTENT_API}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path: BACKUP_PATH }),
    },
  });
  if (res.status === 409) throw new Error("No backup file found in Dropbox");
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  return res.json();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showMessage(text, type = "info") {
  const box = document.getElementById("message-box");
  box.textContent = text;
  box.className = type;
  box.classList.remove("hidden");
}

function escHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Pure JS MozLz4 Decompressor ───────────────────────────────────────────
async function parseMozLz4(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const textDecoder = new TextDecoder();

  // 1. Verify 8-byte magic header
  const magic = textDecoder.decode(u8.subarray(0, 8));
  if (magic !== "mozLz40\0")
    throw new Error("Invalid signature (not a Firefox mozlz4 file)");

  // 2. Read 4-byte little-endian uncompressed size
  const uncompressedSize = new DataView(buf).getUint32(8, true);

  // 3. Decompress the LZ4 block payload
  const compressed = u8.subarray(12);
  const decompressed = decompressLz4Block(compressed, uncompressedSize);

  return textDecoder.decode(decompressed);
}

function decompressLz4Block(input, uncompressedSize) {
  const output = new Uint8Array(uncompressedSize);
  let i = 0,
    o = 0;

  while (i < input.length) {
    const token = input[i++];
    let litLen = token >> 4;

    // Calculate literal length
    if (litLen === 15) {
      let l;
      do {
        l = input[i++];
        litLen += l;
      } while (l === 255);
    }

    if (i + litLen > input.length || o + litLen > output.length) {
      throw new Error("LZ4 literal copy out of bounds");
    }

    // Copy literals
    for (let j = 0; j < litLen; j++) output[o++] = input[i++];

    if (i >= input.length) break; // Normal end of block

    // Read 2-byte little-endian match offset
    if (i + 2 > input.length) throw new Error("LZ4 missing offset");
    const offset = input[i++] | (input[i++] << 8);
    if (offset === 0) throw new Error("Invalid LZ4 match offset");

    // Calculate match length
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let l;
      do {
        l = input[i++];
        matchLen += l;
      } while (l === 255);
    }
    matchLen += 4; // Minimum match length is 4 in LZ4

    if (o + matchLen > output.length)
      throw new Error("LZ4 match copy out of bounds");

    const matchPos = o - offset;
    if (matchPos < 0) throw new Error("LZ4 match position negative");

    // Copy match (byte-by-byte to support overlapping sequences)
    for (let j = 0; j < matchLen; j++) {
      output[o] = output[matchPos + j];
      o++;
    }
  }
  return output;
}

// ─── i18n Helper ────────────────────────────────────────────────────────────

function t(key, ...subs) {
  // Fetches the translated string from _locales/en/messages.json
  return browser.i18n.getMessage(key, subs) || key;
}

function applyI18n() {
  // Replaces all elements with data-i18n attributes with their translations
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}
