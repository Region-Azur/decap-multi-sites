const config = require("../config");
const { getFaviconHTML } = require("../../shared/favicon");
const { escapeJs } = require("../utils/escape");

function renderDecapShell(site, token, nonce = "") {
  const siteId = site.id;
  const repoParts = (site.github_repo || "").split("/");
  const repoOwner = repoParts[0] || "";
  const repoName = repoParts[1] || "";
  const hasCustomDomain = Boolean((site.domain || "").trim());
  const rawDomain = (site.domain || "").trim();
  const domainUrl = rawDomain
    ? (rawDomain.startsWith("http://") || rawDomain.startsWith("https://")
      ? rawDomain
      : `https://${rawDomain}`)
    : "";
  const publicSiteUrl = hasCustomDomain
    ? domainUrl
    : (repoOwner && repoName ? `https://${repoOwner}.github.io/${repoName}/` : "");
  const internalLinkPrefix = hasCustomDomain || !repoName ? "" : `/${repoName}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Decap CMS - ${siteId}</title>
    ${getFaviconHTML()}
    <script nonce="${nonce}">window.CMS_MANUAL_INIT = true;</script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==" crossorigin="anonymous" referrerpolicy="no-referrer" />
    <style>
      #loginOverlay {
        visibility: visible;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
      }
      #loginOverlay.hidden { 
        visibility: hidden; 
      }
      .login-spinner {
        width: 56px;
        height: 56px;
        border: 6px solid rgba(255, 255, 255, 0.4);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .decap-menu-item {
        border-bottom: 1px solid rgb(234, 235, 241);
        cursor: pointer;
        background-color: transparent;
        border-radius: 0px;
        color: rgb(49, 61, 62);
        font-weight: 500;
        padding: 8px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-width: max-content;
        font-size: 14px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        transition: all 0.2s;
      }
      .decap-menu-item:hover,
      .decap-menu-item:active,
      .decap-menu-item:focus {
        color: rgb(58, 105, 199);
        background-color: rgb(232, 245, 254);
      }
      .sidebar-icon-preview {
        margin-top: 8px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: 1px solid #d9dde8;
        border-radius: 6px;
        background: #f8fafc;
        color: #334155;
        font-size: 13px;
      }
      .sidebar-icon-preview-glyph {
        width: 18px;
        text-align: center;
      }
    </style>
    <script nonce="${nonce}">
      window.mockUser = {
        url: "${escapeJs(config.API_BASE_URL)}",
        backend: { name: "git-gateway" },
        api: { request: (path) => { console.log("Mock API Request:", path); return Promise.resolve(); } },
        token: {
          access_token: "${escapeJs(token)}",
          refresh_token: "dummy-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          expires_at: Date.now() + 3600000
        },
        id: "user-id",
        email: "auto-login@example.com",
        user_metadata: { full_name: "Auto User" },
        app_metadata: { provider: "email" },
        jwt: (force) => Promise.resolve("${escapeJs(token)}"),
        logout: () => Promise.resolve()
      };

      // Mark user as ready immediately - we have the token from the portal
      window.isUserReady = true;

      window.netlifyIdentity = {
        currentUser: () => window.mockUser,
        _listeners: { login: [] },
        on: (event, cb) => {
          if (!window.netlifyIdentity._listeners[event]) {
            window.netlifyIdentity._listeners[event] = [];
          }
          window.netlifyIdentity._listeners[event].push(cb);
          
          if (event === 'login' && window.isUserReady) {
            console.log("Late listener registered. Firing immediately.");
            try {
              cb(window.mockUser);
            } catch (err) {
              console.error("Error in late login listener:", err);
            }
          }
        },
        close: () => { console.log("Netlify Identity Widget closed."); },
        logout: () => { console.log("Netlify Identity Widget logout."); },
        open: () => { console.log("Netlify Identity Open called (Mock)"); },
        init: () => { 
          console.log("Netlify Identity Init called (Mock)");
          const loginOverlay = document.getElementById("loginOverlay");
          if (loginOverlay) {
            loginOverlay.classList.add("hidden");
          }
          document.body.classList.remove("login-blocked");
        },
        refresh: () => Promise.resolve("${escapeJs(token)}")
      };
    </script>
  </head>
  <body class="login-blocked">
    <div id="loginOverlay" aria-live="polite" aria-busy="true">
      <div class="login-spinner" role="status" aria-label="Logging in"></div>
    </div>
    <script nonce="${nonce}" src="https://unpkg.com/decap-cms@3.10.0/dist/decap-cms.js"></script>
    <script nonce="${nonce}">
      document.addEventListener("DOMContentLoaded", async function() {
        const loginOverlay = document.getElementById("loginOverlay");
        const freeSidebarIconOptions = [
          { label: "None", value: "" },
          { label: "Book", value: "fa-solid fa-book" },
          { label: "Graduation Cap", value: "fa-solid fa-graduation-cap" },
          { label: "Chalkboard", value: "fa-solid fa-chalkboard" },
          { label: "Users", value: "fa-solid fa-users" },
          { label: "User", value: "fa-solid fa-user" },
          { label: "House", value: "fa-solid fa-house" },
          { label: "Folder", value: "fa-solid fa-folder" },
          { label: "File", value: "fa-solid fa-file" },
          { label: "File Lines", value: "fa-solid fa-file-lines" },
          { label: "Pen", value: "fa-solid fa-pen" },
          { label: "Pencil", value: "fa-solid fa-pencil" },
          { label: "Clipboard", value: "fa-solid fa-clipboard" },
          { label: "List", value: "fa-solid fa-list" },
          { label: "Circle Info", value: "fa-solid fa-circle-info" },
          { label: "Circle Question", value: "fa-solid fa-circle-question" },
          { label: "Circle Check", value: "fa-solid fa-circle-check" },
          { label: "Triangle Exclamation", value: "fa-solid fa-triangle-exclamation" },
          { label: "Bullhorn", value: "fa-solid fa-bullhorn" },
          { label: "Calendar", value: "fa-solid fa-calendar" },
          { label: "Clock", value: "fa-solid fa-clock" },
          { label: "Image", value: "fa-solid fa-image" },
          { label: "Camera", value: "fa-solid fa-camera" },
          { label: "Video", value: "fa-solid fa-video" },
          { label: "Link", value: "fa-solid fa-link" },
          { label: "Globe", value: "fa-solid fa-globe" },
          { label: "Map", value: "fa-solid fa-map" },
          { label: "Location Dot", value: "fa-solid fa-location-dot" },
          { label: "Envelope", value: "fa-solid fa-envelope" },
          { label: "Phone", value: "fa-solid fa-phone" },
          { label: "Paperclip", value: "fa-solid fa-paperclip" },
          { label: "Download", value: "fa-solid fa-download" },
          { label: "Upload", value: "fa-solid fa-upload" },
          { label: "Cloud", value: "fa-solid fa-cloud" },
          { label: "Gear", value: "fa-solid fa-gear" },
          { label: "Wrench", value: "fa-solid fa-wrench" },
          { label: "Shield", value: "fa-solid fa-shield" },
          { label: "Lock", value: "fa-solid fa-lock" },
          { label: "Eye", value: "fa-solid fa-eye" },
          { label: "Star", value: "fa-solid fa-star" },
          { label: "Heart", value: "fa-solid fa-heart" },
          { label: "Flag", value: "fa-solid fa-flag" },
          { label: "Tag", value: "fa-solid fa-tag" },
          { label: "Award", value: "fa-solid fa-award" }
        ];

        const isFontAwesomeIconValue = (value) => {
          const trimmed = String(value || "").trim();
          return /^fa-(solid|regular|brands)\s+fa-[a-z0-9-]+$/i.test(trimmed);
        };

        const iconClassByLabel = new Map(
          freeSidebarIconOptions
            .filter((entry) => entry && entry.label && entry.value)
            .map((entry) => [entry.label.trim(), entry.value.trim()])
        );

        const decorateIconTextNode = (el, iconClass) => {
          if (!el || !iconClass) {
            return;
          }

          const originalText = el.textContent ? el.textContent.trim() : "";
          if (!originalText) {
            return;
          }

          if (
            el.getAttribute("data-icon-decorated") === "true" &&
            el.getAttribute("data-icon-label") === originalText
          ) {
            return;
          }

          el.innerHTML = "";

          const icon = document.createElement("i");
          icon.className = iconClass;
          icon.style.marginRight = "8px";
          icon.style.width = "14px";
          icon.style.textAlign = "center";

          const text = document.createElement("span");
          text.textContent = originalText;

          el.appendChild(icon);
          el.appendChild(text);
          el.setAttribute("data-icon-decorated", "true");
          el.setAttribute("data-icon-label", originalText);
        };

        const renderIconsInSidebarDropdown = () => {
          // Selected value in closed control
          document.querySelectorAll("input[id^='sidebar_icon-field-']").forEach((input) => {
            const control = input.closest("[class*='container']");
            if (!control) return;

            const singleValue = control.querySelector("[class*='singleValue']");
            if (singleValue) {
              const label = (singleValue.textContent || "").trim();
              const iconClass = iconClassByLabel.get(label);
              if (iconClass) {
                decorateIconTextNode(singleValue, iconClass);
              }
            }

            // Options in opened dropdown listbox
            const listboxId = input.getAttribute("aria-controls");
            if (!listboxId) return;
            const listbox = document.getElementById(listboxId);
            if (!listbox) return;

            listbox.querySelectorAll("[role='option']").forEach((optionEl) => {
              const label = (optionEl.textContent || "").trim();
              const iconClass = iconClassByLabel.get(label);
              if (iconClass) {
                decorateIconTextNode(optionEl, iconClass);
              }
            });
          });
        };

        const ensureSidebarIconPreview = (field) => {
          if (!field || field.dataset.iconPreviewBound === "true") {
            return;
          }

          const preview = document.createElement("div");
          preview.className = "sidebar-icon-preview";

          const icon = document.createElement("i");
          icon.className = "sidebar-icon-preview-glyph";

          const text = document.createElement("span");
          preview.appendChild(icon);
          preview.appendChild(text);

          const updatePreview = () => {
            const value = String(field.value || "").trim();
            if (!value) {
              icon.className = "sidebar-icon-preview-glyph";
              text.textContent = "No icon selected";
              return;
            }

            if (!isFontAwesomeIconValue(value)) {
              icon.className = "sidebar-icon-preview-glyph";
              text.textContent = value;
              return;
            }

            icon.className = "sidebar-icon-preview-glyph " + value;
            text.textContent = value;
          };

          field.insertAdjacentElement("afterend", preview);
          field.addEventListener("change", updatePreview);
          field.addEventListener("input", updatePreview);
          field.dataset.iconPreviewBound = "true";
          updatePreview();
        };

        const getControlContainer = (el) => {
          if (!el) return null;
          return el.closest(".css-a6y0jg-ControlContainer") || el.closest("div[class*='ControlContainer']");
        };

        const findFieldControlByPrefix = (prefix) => {
          const input = document.querySelector("input[id^='" + prefix + "-field-'], textarea[id^='" + prefix + "-field-']");
          if (input) {
            const container = getControlContainer(input);
            if (container) return container;
          }

          const comboInput = document.querySelector("input[id^='" + prefix + "-field-'][role='combobox']");
          if (comboInput) {
            const container = getControlContainer(comboInput);
            if (container) return container;
          }

          const label = document.querySelector("label[for^='" + prefix + "-field-']");
          if (label) {
            return getControlContainer(label);
          }

          return null;
        };

        const getSidebarToggleState = () => {
          const toggleButton = document.querySelector("button[id^='sidebar-field-'][role='switch']");
          if (!toggleButton) return true;
          return String(toggleButton.getAttribute("aria-checked")) === "true";
        };

        const syncSidebarDependentFields = () => {
          const isSidebarEnabled = getSidebarToggleState();
          const sidebarDependentFields = ["sidebar_title", "sidebar_icon", "sidebar_order"];

          sidebarDependentFields.forEach((fieldPrefix) => {
            const control = findFieldControlByPrefix(fieldPrefix);
            if (!control) return;

            control.style.display = isSidebarEnabled ? "" : "none";
            control.setAttribute("aria-hidden", isSidebarEnabled ? "false" : "true");
          });
        };

        const bindSidebarToggleListener = () => {
          const toggleButton = document.querySelector("button[id^='sidebar-field-'][role='switch']");
          if (!toggleButton || toggleButton.dataset.sidebarBound === "true") {
            return;
          }

          const syncLater = () => {
            // Decap updates aria-checked during event cycle
            setTimeout(syncSidebarDependentFields, 0);
          };

          toggleButton.addEventListener("click", syncLater);
          toggleButton.addEventListener("keydown", syncLater);
          toggleButton.dataset.sidebarBound = "true";
        };

        const attachSidebarIconPreviews = () => {
          document.querySelectorAll("select").forEach((select) => {
            const hasIconOptions = Array.from(select.options || []).some((option) =>
              isFontAwesomeIconValue(option.value)
            );
            if (hasIconOptions) {
              ensureSidebarIconPreview(select);
            }
          });

          // Fallback for any text-based icon field that may still exist
          document.querySelectorAll("input[type='text']").forEach((input) => {
            if (
              input.name === "sidebar_icon" ||
              input.id === "sidebar_icon" ||
              input.closest("[class*='sidebar_icon']")
            ) {
              ensureSidebarIconPreview(input);
            }
          });
        };

        try {
          const previewObserver = new MutationObserver(() => {
            attachSidebarIconPreviews();
            renderIconsInSidebarDropdown();
              bindSidebarToggleListener();
              syncSidebarDependentFields();
          });

          previewObserver.observe(document.body, {
            childList: true,
            subtree: true,
          });

          attachSidebarIconPreviews();
          renderIconsInSidebarDropdown();
            bindSidebarToggleListener();
            syncSidebarDependentFields();
        } catch (enhancementErr) {
          console.warn("Sidebar icon enhancement disabled:", enhancementErr);
        }

        const hideLoginOverlay = () => {
          if (loginOverlay) {
            loginOverlay.classList.add("hidden");
          }
          document.body.classList.remove("login-blocked");
        };

        if (window.CMS) {
          console.log("Initializing CMS...");
          localStorage.removeItem("netlify-cms-user");

          const internalLinkPrefix = ${JSON.stringify(internalLinkPrefix)};
          const normalizePageSlug = function(value) {
            const rawValue = String(value || "").trim();
            if (!rawValue) return "";

            const withoutProtocol = rawValue.replace(new RegExp("^https?://[^/]+", "i"), "");
            let normalized = withoutProtocol.replace(new RegExp("^/+|/+$", "g"), "");

            if (internalLinkPrefix) {
              const normalizedPrefix = internalLinkPrefix.replace(new RegExp("^/+|/+$", "g"), "");
              if (normalized === normalizedPrefix) return "";
              if (normalized.startsWith(normalizedPrefix + "/")) {
                normalized = normalized.slice(normalizedPrefix.length + 1);
              }
            }
            return normalized;
          };

          const buildInternalLink = function(pageSlug) {
            const normalizedSlug = normalizePageSlug(pageSlug);
            if (!normalizedSlug) return "#";
            return (internalLinkPrefix || "") + "/" + normalizedSlug + "/";
          };

          const normalizeDownloadPath = function(rawPath) {
            const value = String(rawPath || "").trim();
            if (!value) return "";
            if (value.startsWith("http://") || value.startsWith("https://")) return value;
            let cleaned = value.replace(/^"+|"+$/g, "");
            if (internalLinkPrefix && cleaned.startsWith(internalLinkPrefix + "/")) {
              cleaned = cleaned.slice(internalLinkPrefix.length + 1);
            }
            while (cleaned.startsWith("/")) {
              cleaned = cleaned.slice(1);
            }
            if (!cleaned.startsWith("static/uploads/")) {
              cleaned = "static/uploads/" + cleaned;
            }
            return "/" + cleaned;
          };

          const escapeAttribute = (value) => String(value || "").replace(/\"/g, "\\\"");

          window.CMS.registerEditorComponent({
            id: "internal-link",
            label: "Internal Link",
            fields: [
              { name: "title", label: "Link Text", widget: "string" },
              {
                name: "path",
                label: "Page",
                widget: "relation",
                collection: "pages",
                search_fields: ["title", "body"],
                value_field: "{{slug}}",
                display_fields: ["title"]
              }
            ],
            pattern: new RegExp("^\\\\[(.+)\\\\]\\\\((\\\\S+)\\\\)$"),
            fromBlock: function(match) {
              return { title: match[1], path: normalizePageSlug(match[2]) };
            },
            toBlock: function(obj) {
              const finalPath = buildInternalLink(obj.path);
              return "[" + obj.title + "](" + finalPath + ")";
            },
            toPreview: function(obj) {
              const previewPath = buildInternalLink(obj.path);
              return '<a href="' + previewPath + '">' + obj.title + '</a>';
            }
          });

          window.CMS.registerEditorComponent({
            id: "download-link",
            label: "Download",
            fields: [
              { name: "label", label: "Button Text", widget: "string", default: "Download" },
              { name: "file", label: "File", widget: "file" },
              { name: "variant", label: "Style", widget: "select", default: "primary", options: ["primary", "outline-primary", "secondary", "link"] },
              { name: "new_tab", label: "Open in new tab", widget: "boolean", required: false, default: true }
            ],
            // Keep matching broad and parse attrs manually so order/quoting differences still round-trip.
            pattern: /\\{\\%\\s*include\\s+download\\.html\\b[^%]*\\%\\}/,
            fromBlock: function(match) {
              const block = match && match[0] ? match[0] : "";
              const readAttr = function(name) {
                const rx = new RegExp(name + "\\\\s*=\\\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\\\s%]+))", "i");
                const m = block.match(rx);
                if (!m) return "";
                return m[1] || m[2] || m[3] || "";
              };

              const newTabRaw = String(readAttr("new_tab") || "").trim().toLowerCase();
              return {
                file: readAttr("href") || "",
                label: readAttr("label") || "Download",
                variant: readAttr("variant") || "primary",
                new_tab: newTabRaw ? newTabRaw === "true" : true,
              };
            },
            toBlock: function(obj) {
              const href = normalizeDownloadPath(obj.file || obj.href || "");
              const label = escapeAttribute(obj.label || "Download");
              const variant = obj.variant || "primary";
              const newTab = obj.new_tab !== false;
              const variantPart = variant ? ' variant="' + variant + '"' : '';
              return '{% include download.html href="' + escapeAttribute(href) + '" label="' + label + '"' + variantPart + ' new_tab=' + newTab + ' %}';
            },
            toPreview: function(obj) {
              const label = escapeAttribute(obj.label || "Download");
              return '<button style="padding:8px 12px;background:#0d6efd;border:1px solid #0d6efd;color:#fff;border-radius:4px;cursor:pointer;">' + label + '</button>';
            }
          });

          const config = {
            backend: {
              name: 'git-gateway',
              api_root: '${escapeJs(config.API_BASE_URL)}/.netlify/git',
              gateway_url: '${escapeJs(config.API_BASE_URL)}/.netlify/git',
              repo: '${escapeJs(site.github_repo)}',
              branch: '${escapeJs(site.branch)}',
              squash_merges: true,
              preview_context: 'deploy'
            },
            site_url: '${escapeJs(publicSiteUrl || config.API_BASE_URL)}',
            display_url: '${escapeJs(publicSiteUrl || config.API_BASE_URL)}',
            logo_url: 'https://decapcms.org/img/decap-logo.svg',
            locale: 'en',
            editor: {
              preview: false
            },
            media_folder: 'static/uploads',
            public_folder: '${escapeJs((internalLinkPrefix || "") + "/static/uploads")}',
            collections: [{
              name: "pages",
              label: "Pages",
              folder: "${escapeJs(site.content_path)}",
              create: true,
              fields: [
                { label: "Title", name: "title", widget: "string" },
                { label: "Show in sidebar", name: "sidebar", widget: "boolean", default: false, required: false },
                { label: "Sidebar title", name: "sidebar_title", widget: "string", required: false, hint: "Defaults to the page title." },
                {
                  label: "Sidebar icon (Font Awesome Free)",
                  name: "sidebar_icon",
                  widget: "select",
                  required: false,
                  default: "",
                  options: freeSidebarIconOptions,
                  hint: "Only free Font Awesome icons are listed (no Pro license required)."
                },
                { label: "Sidebar order", name: "sidebar_order", widget: "number", required: false, hint: "Lower numbers appear first." },
                { label: "Table of contents", name: "toc", widget: "boolean", default: true, required: false },
                { label: "Body", name: "body", widget: "markdown" }
              ]
            }]
          };

          console.log("Initializing CMS with manual config...", config);
          window.CMS.init({ config, load_config_file: false });

          // Register custom media preview handler to load images from API during editing
          // This ensures images display correctly in the editor even before they're published
          window.CMS.registerMediaLibrary({
            name: "image-preview-handler",
            init: () => {
              // Hook into the markdown widget to rewrite image URLs for preview
              const originalMarkdownToPreview = window.CMS.widgets.markdown;
              if (originalMarkdownToPreview && originalMarkdownToPreview.preview) {
                const originalPreview = originalMarkdownToPreview.preview;
                window.CMS.widgets.markdown.preview = function(props) {
                  // This is called for preview rendering
                  return originalPreview.call(this, props);
                };
              }
            }
          });

          // Intercept fetch requests to rewrite media URLs for editor preview
          const originalFetch = window.fetch;
          window.fetch = function(...args) {
            const url = args[0];
            // If this is a request for a static/uploads file, rewrite it to use our API endpoint
            if (typeof url === 'string' && url.includes('static/uploads')) {
              const sitePath = '${escapeJs(site.id)}';
              const newUrl = url.replace(
                /.*static\\/uploads\\/(.*)/,
                '/api/sites/' + sitePath + '/media/static/uploads/$1'
              );
              args[0] = newUrl;
            }
            return originalFetch.apply(this, args);
          };


          setTimeout(async () => {
            try {
              console.log("Fetching /api/user...");
              const res = await fetch('/api/user', {
                headers: { 'Authorization': 'Bearer ${escapeJs(token)}' }
              });
              console.log("Fetch /api/user status: " + res.status);

              if (res.ok) {
                const user = await res.json();
                if (window.mockUser) {
                  window.mockUser.id = user.id;
                  window.mockUser.email = user.email;
                  window.mockUser.user_metadata.full_name = user.name;
                }

                window.isUserReady = true;
                console.log("Mock user ready. Firing login event...");

                const fireLogin = (attempt = 1) => {
                  if (window.netlifyIdentity._listeners.login && window.netlifyIdentity._listeners.login.length > 0) {
                    console.log("Firing " + window.netlifyIdentity._listeners.login.length + " login listeners (Attempt " + attempt + ")...");
                    window.netlifyIdentity._listeners.login.forEach(cb => {
                      try {
                        cb(window.mockUser);
                      } catch (err) {
                        console.error("Error in login listener:", err);
                      }
                    });
                  } else {
                    if (attempt <= 20) {
                      console.log("No login listeners yet (Attempt " + attempt + "). Retrying in 500ms...");
                      setTimeout(() => fireLogin(attempt + 1), 500);
                    } else {
                      console.warn("Max retries reached. CMS did not register login listener.");
                    }
                  }
                };

                fireLogin();
              } else {
                const errText = await res.text();
                console.error("Fetch /api/user failed: " + errText);
              }
            } catch (e) {
              console.error("Auto-login exception", e);
            }
          });
        } else {
          console.error("CMS global not found!");
        }

        // Handle Decap CMS logout button to redirect to OAuth2-Proxy logout
        const handleLogoutClick = () => {
          const observer = new MutationObserver(() => {
            const logoutItems = document.querySelectorAll('[role="menuitem"]');
            logoutItems.forEach(item => {
              if (item.textContent.includes('Log Out') && !item.hasAttribute('data-logout-handled')) {
                item.setAttribute('data-logout-handled', 'true');
                item.addEventListener('click', () => {
                  window.location.href = '/oauth2/sign_out';
                });
                
                // Add Back to Sites menu item if it doesn't exist
                const ul = item.parentElement;
                if (ul && !ul.querySelector('[data-back-to-sites]')) {
                  const backToSitesDiv = document.createElement('div');
                  backToSitesDiv.setAttribute('role', 'menuitem');
                  backToSitesDiv.setAttribute('tabindex', '-1');
                  backToSitesDiv.setAttribute('data-back-to-sites', 'true');
                  backToSitesDiv.className = 'decap-menu-item';
                  backToSitesDiv.innerHTML = '<span>Back to Sites</span>';
                  backToSitesDiv.addEventListener('click', () => {
                    window.location.href = '/sites';
                  });
                  ul.appendChild(backToSitesDiv);
                }
              }
            });
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false
          });
        };

        setTimeout(handleLogoutClick, 1000);
      });
    </script>
  </body>
</html>`;
}

module.exports = { renderDecapShell };

