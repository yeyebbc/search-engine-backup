document.addEventListener("DOMContentLoaded", async () => {
  const { last_restore } = await browser.storage.local.get("last_restore");

  if (!last_restore) {
    document.getElementById("engine-list").innerHTML =
      '<p style="color:red">No restore data found. Run a restore from the extension popup first.</p>';
    return;
  }

  const { engines, backupDate, defaultEngine } = last_restore;

  document.getElementById("meta").textContent = `Backup from ${new Date(
    backupDate
  ).toLocaleString()} · ${engines.length} engines · Default: ${
    defaultEngine || "unknown"
  }`;

  const list = document.getElementById("engine-list");

  for (const engine of engines) {
    const row = document.createElement("div");
    row.className = "engine-row";

    if (!engine.searchUrl) {
      row.innerHTML = `
          <div class="engine-info">
            <div class="engine-name">${esc(engine.name)} ${
        engine.isDefault ? "⭐" : ""
      }</div>
            <div class="no-url">No URL saved for this engine — it may be a built-in engine already present.</div>
          </div>`;
    } else {
      const opensearchUrl = buildOpenSearchBlobUrl(engine);
      row.innerHTML = `
          <div class="engine-info">
            <div class="engine-name">${esc(engine.name)} ${
        engine.isDefault ? "⭐" : ""
      }
              ${
                engine.alias
                  ? `<span style="color:#888;font-size:11px">${esc(
                      engine.alias
                    )}</span>`
                  : ""
              }
            </div>
            <div class="engine-url">${esc(engine.searchUrl)}</div>
          </div>
          <button class="add-btn" data-url="${esc(
            opensearchUrl
          )}" data-name="${esc(engine.name)}">
            Add to Firefox
          </button>`;
    }

    list.appendChild(row);
  }

  // Clicking "Add to Firefox" opens a discovery page that triggers Firefox's
  // native "Add Search Engine" dialog via the OpenSearch <link> element.
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".add-btn");
    if (!btn) return;
    openDiscoveryPage(btn.dataset.url, btn.dataset.name);
    btn.textContent = "✓ Opening…";
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = '<span class="added-badge">✓ Added?</span>';
    }, 2000);
  });
});

function buildOpenSearchBlobUrl(engine) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
    <ShortName>${esc(engine.name)}</ShortName>
    <Description>Search using ${esc(engine.name)}</Description>
    <Url type="text/html" method="GET" template="${esc(engine.searchUrl)}"/>
    ${
      engine.favIconUrl
        ? `<Image height="16" width="16">${esc(engine.favIconUrl)}</Image>`
        : ""
    }
  </OpenSearchDescription>`;

  const blob = new Blob([xml], {
    type: "application/opensearchdescription+xml",
  });
  return URL.createObjectURL(blob);
}

function openDiscoveryPage(opensearchBlobUrl, engineName) {
  // Build a minimal HTML page that declares the OpenSearch link, causing
  // Firefox to offer the "Add Search Engine" option in the address bar.
  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Add ${esc(engineName)}</title>
    <link rel="search"
          type="application/opensearchdescription+xml"
          title="${esc(engineName)}"
          href="${opensearchBlobUrl}">
  </head>
  <body>
    <h2>Adding: ${esc(engineName)}</h2>
    <p>Look for the search engine icon in Firefox's address bar, or go to
       <strong>Settings → Search</strong> to confirm it was added.</p>
  </body>
  </html>`;

  const pageBlob = new Blob([html], { type: "text/html" });
  const pageUrl = URL.createObjectURL(pageBlob);
  browser.tabs.create({ url: pageUrl });
}

function esc(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
