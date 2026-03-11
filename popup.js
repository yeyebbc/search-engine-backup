const DROPBOX_CONTENT_API = "https://content.dropboxapi.com/2";
const BACKUP_PATH = "/firefox_search_backup.json";

// ─── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await checkAuthState();
  await loadEngines();

  document
    .getElementById("auth-btn")
    .addEventListener("click", handleAuthClick);
  document.getElementById("backup-btn").addEventListener("click", doBackup);
  document.getElementById("restore-btn").addEventListener("click", doRestore);
  document.getElementById("refresh-btn").addEventListener("click", loadEngines);
});

async function checkAuthState() {
  const { dropbox_access_token } = await browser.storage.local.get(
    "dropbox_access_token"
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
    "dropbox_access_token"
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
                engine.alias
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
      "success"
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
        payload.backupDate
      ).toLocaleString()}.`,
      "success"
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
