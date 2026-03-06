const config = require("../config");
const { getFaviconHTML } = require("../../shared/favicon");

function renderSitePicker(user, sites, isAdmin = false) {
  const listItems = sites
    .map((site) => {
      const settingsButton = `<button class="gear" type="button" data-site-id="${site.id}" data-display-name="${site.display_name}" data-page-title="${site.page_title || ''}" data-suptitle="${site.suptitle || 'Built with Decap CMS'}" data-brand-icon="${site.brand_icon || ''}" data-favicon="${site.favicon || ''}" title="Site settings">⚙️</button>`;
      return `<li class="site-card"><a class="site-link" href="/sites/${site.id}">${site.display_name}</a>${settingsButton}</li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Decap CMS Portal</title>
    ${getFaviconHTML()}
    <link rel="stylesheet" href="/css/main.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css">
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <h1>Welcome, ${user.name}</h1>
        <div class="top-actions">
          ${isAdmin ? '<a class="admin-link" href="/admin">Admin Panel</a>' : ''}
          <a id="logoutBtn" class="logout-link" href="/oauth2/sign_out">Logout</a>
        </div>
      </div>
      <h2>Available sites</h2>
      <ul>${listItems || '<li>No sites assigned.</li>'}</ul>
    </div>

    <dialog id="siteSettingsDialog">
      <form id="siteSettingsForm">
        <h3 id="settingsTitle">Site settings</h3>
        <input type="hidden" name="site_id" id="site_id" />
        <div class="form-row">
          <label for="page_title">Page Title</label>
          <input type="text" name="page_title" id="page_title" placeholder="Aure 2"/>
        </div>
        <div class="form-row">
          <label for="suptitle">Suptitle</label>
          <input type="text" name="suptitle" id="suptitle" placeholder="Built with Decap CMS"/>
        </div>
        <div class="form-row">
          <label for="brand_icon">Icon URL (Chirpy avatar)</label>
          <input type="url" name="brand_icon" id="brand_icon" placeholder="https://.../icon.png"/>
          <p class="hint">Or upload an image file (square crop enforced).</p>
          <input type="file" id="brand_icon_file" accept="image/*"/>
          <div id="brand_icon_preview" class="file-preview"></div>
        </div>
        <div class="form-row">
          <label for="favicon">Favicon URL</label>
          <input type="url" name="favicon" id="favicon" placeholder="https://.../favicon.ico"/>
          <p class="hint">Or upload an image file.</p>
          <input type="file" id="favicon_file" accept="image/*"/>
          <div id="favicon_preview" class="file-preview"></div>
          <p class="hint">If empty, the icon above is reused. Leaving both empty keeps existing behavior.</p>
        </div>
        <div class="actions">
          <button type="button" class="btn btn-secondary" id="cancelSettings">Cancel</button>
          <button type="submit" class="btn btn-primary" id="saveSettings">
            <span class="btn-label">Save</span>
            <span class="btn-spinner" aria-hidden="true"></span>
          </button>
        </div>
      </form>

      <div id="settingsNotice" class="settings-notice" aria-hidden="true" role="dialog" aria-label="Settings saved">
        <div class="settings-notice-card">
          <strong>Saved</strong>
          <p>Site settings saved. Favicon assets are being generated and pushed to GitHub.</p>
          <div class="settings-notice-actions">
            <button type="button" class="btn btn-primary" id="settingsNoticeOk">Okay</button>
          </div>
        </div>
      </div>
    </dialog>

    <div id="cropModal" class="crop-modal" aria-hidden="true">
      <div class="crop-container">
        <h3>Crop Image (Square)</h3>
        <p style="margin:0 0 16px; color:#4b5563;">Drag to position, scroll to zoom. Result is always a perfect square.</p>
        <div class="cropper-shell"><img id="cropperImage" src="" alt="Image to crop"></div>
        <div class="crop-actions">
          <button type="button" class="btn btn-secondary" id="cropCancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="cropConfirm">Use Cropped Image</button>
        </div>
      </div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js"></script>
    <script src="/js/sitePicker.js"></script>
  </body>
</html>`;
}

module.exports = { renderSitePicker };

