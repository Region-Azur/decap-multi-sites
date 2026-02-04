const crypto = require("crypto");
const express = require("express");
const { createDb, ensureSchema } = require("./shared/db");

const PORT = Number(process.env.PORTAL_PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_OIDC_ISSUER = process.env.HITOBITO_OIDC_ISSUER || "";
const API_BASE_URL = process.env.API_BASE_URL || process.env.PORTAL_BASE_URL || "";
const USERINFO_URL_OVERRIDE = process.env.HITOBITO_USERINFO_URL || "";

const app = express();
const db = createDb(DATABASE_URL);

function normalizeEmail(value) {
  if (!value) {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : "";
}

async function fetchUserInfo(issuer, accessToken) {
  try {
    const normalizedIssuer = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const normalizedOverride = USERINFO_URL_OVERRIDE.replace(/\/$/, "");
    const userInfoUrl = normalizedOverride || `${normalizedIssuer}/oauth/userinfo`;
    const userInfoRes = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      console.log("DEBUG: User info fetched:", JSON.stringify(userInfo, null, 2));
      return userInfo;
    } else {
      console.error("DEBUG: Failed to fetch user info:", userInfoRes.status, await userInfoRes.text())
    }
  } catch (err) {
    console.error("DEBUG: Error fetching user info:", err);
  }
  return null;
}

async function getAuthInfo(req) {
  // Log all headers for debugging purposes
  console.log("DEBUG: Incoming headers:", JSON.stringify(req.headers, null, 2));

  // Helper to parse JWT payload
  const parseJwt = (token) => {
    try {
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    } catch (e) {
      return null;
    }
  };

  const issuer = req.header("x-auth-request-issuer") || DEFAULT_OIDC_ISSUER;

  // Try X-Auth-Request headers first, then fall back to X-Forwarded headers
  const sub = req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader = req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername = req.header("x-auth-request-preferred-username") || req.header("x-forwarded-preferred-username");
  const nameHeader = req.header("x-auth-request-name") || req.header("x-forwarded-name");
  const accessToken = req.header("x-auth-request-access-token") || req.header("x-forwarded-access-token");
  const idToken = req.header("x-auth-request-id-token") || req.header("x-forwarded-id-token");

  let email = normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  let name = nameHeader || preferredUsername || sub || emailHeader;

  // Attempt to extract better name from ID Token if available
  if (idToken) {
    const claims = parseJwt(idToken);
    if (claims) {
      console.log("DEBUG: ID Token claims:", JSON.stringify(claims, null, 2));
      if (claims.name) {
        name = claims.name;
      } else if (claims.nickname) {
        name = claims.nickname;
      } else if (claims.given_name) {
        name = claims.given_name;
        if (claims.family_name) name += ` ${claims.family_name}`;
      }
    }
  }

  console.log(`DEBUG: Extracted auth info: issuer=${issuer}, sub=${sub}, email=${email}, name=${name}`);

  if (!issuer || !sub || !email) {
    console.log("DEBUG: Auth info missing required fields");
    return null;
  }

  return {
    issuer,
    sub,
    email,
    name,
    accessToken,
  };
}

async function getOrCreateUser(auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) {
    // Force sync if name looks like an ID (matches sub) or it's been 24h
    const nameIsId = existing.name === existing.oidc_sub || existing.name === auth.sub;
    const shouldSync = auth.accessToken && auth.issuer && (nameIsId || !existing.last_synced_at || Date.now() - new Date(existing.last_synced_at).getTime() > 24 * 60 * 60 * 1000);

    if (shouldSync) {
      console.log(`DEBUG: Syncing user info for ${auth.email}`);
      try {
        const userInfo = await fetchUserInfo(auth.issuer, auth.accessToken);

        if (userInfo) {
          let newName = existing.name; // Default to existing
          const nickname = userInfo.nickname;
          const givenName = userInfo.given_name || userInfo.first_name;
          const familyName = userInfo.family_name || userInfo.last_name;
          const name = userInfo.name;

          if (nickname) {
            newName = nickname;
          } else if (givenName) {
            newName = givenName;
            if (familyName) {
              newName += ` ${familyName}`;
            }
          } else if (name) {
            newName = name;
          }

          await db("users").where({ id: existing.id }).update({
            name: newName,
            last_synced_at: new Date(),
          });

          return { ...existing, name: newName };
        }
      } catch (e) {
        console.warn(`DEBUG: Failed to sync user info (ignoring): ${e.message}`);
      }
    }
    return existing;

  }

  const isFirstUser = (await db("users").count("id as count").first()).count === 0;
  const isAdmin = isFirstUser || ADMIN_EMAILS.includes(auth.email);
  const id = crypto.randomUUID();

  // Fetch initial info for new user
  let initialName = auth.name;
  let lastSyncedAt = null;

  if (auth.accessToken && auth.issuer) {
    try {
      const userInfo = await fetchUserInfo(auth.issuer, auth.accessToken);
      if (userInfo) {
        lastSyncedAt = new Date();
        const { nickname, given_name, family_name, name } = userInfo;
        if (nickname) {
          initialName = nickname;
        } else if (given_name) {
          initialName = given_name;
          if (family_name) {
            initialName += ` ${family_name}`;
          }
        } else if (name) {
          initialName = name;
        }
      }
    } catch (e) {
      console.warn(`DEBUG: Failed to fetch initial user info (using fallback): ${e.message}`);
    }
  }

  await db("users").insert({
    id,
    oidc_issuer: auth.issuer,
    oidc_sub: auth.sub,
    email: auth.email,
    name: initialName,
    is_admin: isAdmin,
    last_synced_at: lastSyncedAt
  });

  return db("users").where({ id }).first();
}

async function listPermittedSites(user) {
  if (user.is_admin) {
    return db("sites").where({ enabled: true }).orderBy("display_name");
  }

  return db("sites")
    .join("site_permissions", "sites.id", "site_permissions.site_id")
    .where({ "site_permissions.user_id": user.id, "sites.enabled": true })
    .select("sites.*")
    .orderBy("sites.display_name");
}

async function hasPermission(user, siteId) {
  console.log(`DEBUG: Checking permission for user ${user.email} (admin=${user.is_admin}) on site ${siteId}`);
  if (user.is_admin) {
    const site = await db("sites").where({ id: siteId, enabled: true }).first();
    console.log(`DEBUG: Site lookup for admin: ${site ? "Found" : "Not Found"} (enabled=true)`);
    if (!site) {
      // Check if site exists but is disabled
      const disabledSite = await db("sites").where({ id: siteId }).first();
      console.log(`DEBUG: Disabled check: ${disabledSite ? "Site exists but disabled" : "Site does not exist"}`);
    }
    return Boolean(site);
  }

  const permission = await db("site_permissions")
    .where({ user_id: user.id, site_id: siteId })
    .first();
  console.log(`DEBUG: Permission lookup for user: ${permission ? "Found" : "Not Found"}`);
  return Boolean(permission);
}

function renderSitePicker(user, sites) {
  const listItems = sites
    .map(
      (site) =>
        `<li><a href="/admin/${site.id}">${site.display_name}</a></li>`
    )
    .join("");

  const adminLink = user.is_admin
    ? '<p><a href="/admin-panel">Admin panel</a></p>'
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Decap CMS Portal</title>
  </head>
  <body>
    <h1>Welcome, ${user.name}</h1>
    ${adminLink}
    <h2>Available sites</h2>
    <ul>${listItems || "<li>No sites assigned.</li>"}</ul>
  </body>
</html>`;
}

function renderAdminPanel(user, sites, permissions) {
  const siteRows = sites.map(s => {
    const owner = s.github_repo.split('/')[0] || 'username';
    const dnsTarget = `${owner}.github.io`;

    let dnsButton = "";
    if (s.domain) {
      const host = s.domain.startsWith('www') ? 'www' : '@';
      const msg = `DNS Setup for ${s.domain}:\\n\\nType: CNAME\\nHost: ${host}\\nValue: ${dnsTarget}`;
      dnsButton = `<button onclick="alert('${msg}')">DNS Info</button>`;
    }

    return `<tr>
      <td><a href="/admin/${s.id}" target="_blank">${s.display_name}</a></td>
      <td>${s.github_repo}</td>
      <td>${s.domain || '<em style="color:#888">None</em>'}</td>
      <td>${dnsButton}</td>
    </tr>`;
  }).join("");

  const permissionRows = permissions.map(p => {
    return `<tr>
      <td>${p.user_email}</td>
      <td>${p.site_name} (${p.site_slug})</td>
      <td><button onclick="revokePermission('${p.user_email}', '${p.site_id}')" style="background: #fee; color: red; border: 1px solid red; cursor:pointer;">Revoke</button></td>
    </tr>`;
  }).join("");

  // Get unique users for the user select dropdown
  // We can extract them from the permissions or assume we might want all users.
  // The original code passed 'users' but we are passing 'permissions'.
  // Let's rely on a separate users list if we want to grant permissions to anyone.
  // But we changed the signature. To keep it simple, we'll just show active permissions for now.
  // If "Grant Permission" needs a list of users, we'd need to pass that too.
  // Let's just fix the Grant Permission form to use text input for now or fetch users if needed.
  // Original code: const users = await db("users").orderBy("name");
  // We should probably pass 'users' as well to populate the dropdown.
  // Changing signature to: renderAdminPanel(user, sites, permissions, allUsers)

  return `<!doctype html>
<html>
<head>
  <title>CMS Admin Panel</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; max-width: 1000px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; }
    input { padding: 0.5rem; width: 100%; max-width: 400px; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    h2 { border-bottom: 2px solid #eee; padding-bottom: 0.5rem; margin-top: 2rem; }
  </style>
  <script>
    async function revokePermission(email, siteId) {
        if(!confirm('Revoke access for ' + email + ' to ' + siteId + '?')) return;
        
        try {
            const res = await fetch('/api/admin/permissions', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, site_id: siteId })
            });
            if (res.ok || res.status === 204) {
                window.location.reload();
            } else {
                const err = await res.json();
                alert('Error: ' + (err.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Network error');
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        document.getElementById('addSiteForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          
          try {
            const res = await fetch('/api/admin/sites', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            if (res.ok) {
               alert('Site created!');
               window.location.reload();
            } else {
               const err = await res.json();
               alert('Error: ' + (err.error || 'Unknown error'));
            }
          } catch (err) { alert('Network error'); }
        });

        document.getElementById('addPermissionForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          
          try {
            const res = await fetch('/api/admin/permissions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            if (res.ok) {
               alert('Permission granted!');
               window.location.reload();
            } else {
               const err = await res.json();
               alert('Error: ' + (err.error || 'Unknown error'));
            }
          } catch (err) { alert('Network error'); }
        });
    });
  </script>
</head>
<body>
  <h1>CMS Admin Panel</h1>
  <p>Logged in as: <strong>${user.name}</strong> (${user.email})</p>

  <h2>Sites</h2>
  <table>
    <tr><th>Name</th><th>Repo</th><th>Domain</th><th>Actions</th></tr>
    ${siteRows}
  </table>

  <h3>Add New Site</h3>
  <form id="addSiteForm">
    <div class="form-group">
      <label>ID (Slug)</label>
      <input name="id" required placeholder="my-site">
    </div>
    <div class="form-group">
      <label>Display Name</label>
      <input name="display_name" required placeholder="My Site">
    </div>
    <div class="form-group">
      <label>GitHub Repo (owner/repo)</label>
      <input name="github_repo" required placeholder="owner/repo">
    </div>
    <div class="form-group">
      <label>Branch</label>
      <input name="branch" value="main">
    </div>
    <div class="form-group">
      <label>Custom Domain (Optional)</label>
      <input name="domain" placeholder="www.example.com">
      <small style="display:block;color:#666">Will auto-configure CNAME in repo</small>
    </div>
    <button type="submit">Create Site</button>
  </form>

  <h2>Active Permissions</h2>
  <table>
    <tr><th>User</th><th>Site</th><th>Action</th></tr>
    ${permissionRows.length ? permissionRows : '<tr><td colspan="3">No active permissions</td></tr>'}
  </table>

  <h3>Grant Permission</h3>
  <form id="addPermissionForm">
    <div class="form-group">
      <label>User Email</label>
      <input name="email" type="email" required>
    </div>
    <div class="form-group">
      <label>Site ID</label>
      <input name="site_id" required>
    </div>
    <button type="submit">Grant Access</button>
  </form>
</body>
</html>`;
}

function renderDecapShell(site, token) {
  const siteId = site.id;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Decap CMS - ${siteId}</title>

    <script>window.CMS_MANUAL_INIT = true;</script>
    <style>
      /* Optional: Hide Netlify Identity Widget default button if it appears */
      div[class^="netlify-identity-menu"] { display: none; }
    </style>
    <script>
      // Hoist Netlify Identity Mock to HEAD so it exists before Decap CMS loads
      window.mockUser = {
          url: "${API_BASE_URL}",
          backend: { name: "git-gateway" },
          api: {
            request: (path) => { console.log("Mock API Request:", path); return Promise.resolve(); }
          },
          token: {
              access_token: "${token}",
              refresh_token: "dummy-refresh-token",
              token_type: "Bearer",
              expires_in: 3600,
              expires_at: Date.now() + 3600000
          },
          id: "user-id",
          email: "auto-login@example.com", 
          user_metadata: { full_name: "Auto User" },
          app_metadata: { provider: "email" },
          jwt: (force) => Promise.resolve("${token}"),
          logout: () => Promise.resolve()
      };

      window.netlifyIdentity = {
          currentUser: () => window.isUserReady ? window.mockUser : null,
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
          init: () => { console.log("Netlify Identity Init called (Mock)"); },
          refresh: () => Promise.resolve("${token}")
      };
    </script>
  </head>

  <body>
    <script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>
    <script>
      document.addEventListener("DOMContentLoaded", async function() {
         if (window.CMS) {
            console.log("Initializing CMS...");

            // Manually Initialize CMS with Config Object
            const config = {
                backend: {
                    name: 'git-gateway',
                    api_root: '${API_BASE_URL}/.netlify/git',
                    gateway_url: '${API_BASE_URL}/.netlify/git', // Legacy fallback restored
                    repo: '${site.github_repo}', 
                    branch: '${site.branch}',
                    squash_merges: true
                },
                site_url: '${API_BASE_URL}',
                display_url: '${API_BASE_URL}',
                logo_url: 'https://decapcms.org/img/decap-logo.svg',
                locale: 'en',
                media_folder: '${site.media_path}',
                public_folder: '${site.media_path}',
                collections: [
                    {
                        name: "pages",
                        label: "Pages",
                        folder: "${site.content_path}",
                        create: true,
                        fields: [
                            {label: "Title", name: "title", widget: "string"},
                            {label: "Body", name: "body", widget: "markdown"}
                        ]
                    }
                ]
            };

            console.log("Initializing CMS with manual config...", config);
            window.CMS.init({ config, load_config_file: false });
            
            // Allow CMS initialization to settle/hydrate before attempting auth flow
            setTimeout(async () => {
                // Auto-login attempt: Verify session with backend and seed local storage
                try {
                    console.log("Fetching /api/user...");
                // Pass the token in the header to authenticate with the API
                const res = await fetch('/api/user', {
                    headers: {
                        'Authorization': 'Bearer ${token}'
                    }
                });
                console.log("Fetch / api / user status: " + res.status);
                
                if (res.ok) {
                    const user = await res.json();
                    
                    // Update mock user with real data
                    if (window.mockUser) {
                        window.mockUser.id = user.id;
                        window.mockUser.email = user.email;
                        window.mockUser.user_metadata.full_name = user.name;
                    }
                    
                    window.isUserReady = true;
                    console.log("Mock user ready. Firing login event...");
                    
                    // Fire login event to authenticate CMS
                    // We need to ensure the CMS has actually registered its listener
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
      });
    </script>
  </body>
</html>`;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function handleAdminHome(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const sites = await listPermittedSites(user);
  res.type("html").send(renderSitePicker(user, sites));
}

async function handleAdminPanel(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  if (!user.is_admin) {
    res.status(403).send("Forbidden. Access restricted to admins.");
    return;
  }

  const sites = await db("sites").orderBy("display_name");

  // Fetch permissions with user details for the UI table
  const permissions = await db("site_permissions")
    .join("users", "site_permissions.user_id", "users.id")
    .join("sites", "site_permissions.site_id", "sites.id")
    .select("site_permissions.user_id", "site_permissions.site_id", "users.email as user_email", "sites.display_name as site_name", "sites.id as site_slug")
    .orderBy("users.email");

  // Fetch all users for the dropdown
  const allUsers = await db("users").orderBy("name");

  res.type("html").send(renderAdminPanel(user, sites, permissions, allUsers));
}

function renderAdminPanel(user, sites, permissions, allUsers) {
  const siteRows = sites.map(s => {
    const owner = s.github_repo.split('/')[0] || 'username';
    const dnsTarget = `${owner}.github.io`;

    let dnsButton = "";
    if (s.domain) {
      const host = s.domain.startsWith('www') ? 'www' : '@';
      const msg = `DNS Setup for ${s.domain}:\\n\\nType: CNAME\\nHost: ${host}\\nValue: ${dnsTarget}`;
      dnsButton = `<button onclick="alert('${msg}')">DNS Info</button>`;
    }

    return `<tr>
      <td><a href="/admin/${s.id}" target="_blank">${s.display_name}</a></td>
      <td>${s.github_repo}</td>
      <td>
        ${s.domain || '<em style="color:#888">None</em>'} 
        <button onclick="editDomain('${s.id}', '${s.domain || ''}')" style="font-size:0.8em; margin-left:5px;">Edit</button>
      </td>
      <td>${dnsButton}</td>
    </tr>`;
  }).join("");

  const permissionRows = permissions.map(p => {
    return `<tr>
      <td>${p.user_email}</td>
      <td>${p.site_name} (${p.site_slug})</td>
      <td><button onclick="revokePermission('${p.user_email}', '${p.site_id}')" style="background: #fee; color: red; border: 1px solid red; cursor:pointer;">Revoke</button></td>
    </tr>`;
  }).join("");

  const userOptions = allUsers.map(u => `<option value="${u.email}">${u.name} (${u.email})</option>`).join("");
  const siteOptions = sites.map(s => `<option value="${s.id}">${s.display_name} (${s.id})</option>`).join("");

  return `<!doctype html>
<html>
<head>
  <title>CMS Admin Panel</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; max-width: 1000px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; }
    input, select { padding: 0.5rem; width: 100%; max-width: 400px; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    h2 { border-bottom: 2px solid #eee; padding-bottom: 0.5rem; margin-top: 2rem; }
  </style>
  <script>
    async function revokePermission(email, siteId) {
        if(!confirm('Revoke access for ' + email + ' to ' + siteId + '?')) return;
        
        try {
            const res = await fetch('/api/admin/permissions', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, site_id: siteId })
            });
            if (res.ok || res.status === 204) {
                window.location.reload();
            } else {
                const err = await res.json();
                alert('Error: ' + (err.error || 'Unknown error'));
            }
        } catch (e) { alert('Network error'); }
    }

    async function editDomain(siteId, currentDomain) {
        const newDomain = prompt("Enter new custom domain (leave empty to remove):", currentDomain);
        if (newDomain === null) return; // Cancelled

        try {
            const res = await fetch('/api/admin/sites/' + siteId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: newDomain })
            });
            if (res.ok) {
                alert('Domain updated!');
                window.location.reload();
            } else {
                const err = await res.json();
                alert('Error: ' + (err.error || 'Unknown error'));
            }
        } catch (e) { alert('Network error'); }
    }

    document.addEventListener("DOMContentLoaded", () => {
        document.getElementById('addSiteForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          
          try {
            const res = await fetch('/api/admin/sites', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            if (res.ok) {
               alert('Site created!');
               window.location.reload();
            } else {
               const err = await res.json();
               alert('Error: ' + (err.error || 'Unknown error'));
            }
          } catch (err) { alert('Network error'); }
        });

        document.getElementById('addPermissionForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          
          try {
            const res = await fetch('/api/admin/permissions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            if (res.ok) {
               alert('Permission granted!');
               window.location.reload();
            } else {
               const err = await res.json();
               alert('Error: ' + (err.error || 'Unknown error'));
            }
          } catch (err) { alert('Network error'); }
        });
    });
  </script>
</head>
<body>
  <h1>CMS Admin Panel</h1>
  <p>Logged in as: <strong>${user.name}</strong> (${user.email})</p>

  <h2>Sites</h2>
  <table>
    <tr><th>Name</th><th>Repo</th><th>Domain</th><th>Actions</th></tr>
    ${siteRows}
  </table>

  <h3>Add New Site</h3>
  <form id="addSiteForm">
    <div class="form-group">
      <label>ID (Slug)</label>
      <input name="id" required placeholder="my-site">
    </div>
    <div class="form-group">
      <label>Display Name</label>
      <input name="display_name" required placeholder="My Site">
    </div>
    <div class="form-group">
      <label>GitHub Repo (owner/repo)</label>
      <input name="github_repo" required placeholder="owner/repo">
    </div>
    <div class="form-group">
      <label>Branch</label>
      <input name="branch" value="main">
    </div>
    <div class="form-group">
      <label>Custom Domain (Optional)</label>
      <input name="domain" placeholder="www.example.com">
      <small style="display:block;color:#666">Will auto-configure CNAME in repo</small>
    </div>
    <button type="submit">Create Site</button>
  </form>

  <h2>Active Permissions</h2>
  <table>
    <tr><th>User</th><th>Site</th><th>Action</th></tr>
    ${permissionRows.length ? permissionRows : '<tr><td colspan="3">No active permissions</td></tr>'}
  </table>

  <h3>Grant Permission</h3>
  <form id="addPermissionForm">
    <div class="form-group">
      <label>User</label>
      <select name="email" required>
        <option value="">Select User...</option>
        ${userOptions}
      </select>
    </div>
    <div class="form-group">
      <label>Site</label>
      <select name="site_id" required>
        <option value="">Select Site...</option>
        ${siteOptions}
      </select>
    </div>
    <button type="submit">Grant Access</button>
  </form>
</body>
</html>`;
}

app.get("/admin", handleAdminHome);
app.get("/admin-panel", handleAdminPanel);

app.get("/admin/config.yml", (_req, res) => {
  // Return minimal valid config to satisfy CMS if manual init fallback fails
  res.type("text/yaml").send("backend:\n  name: git-gateway\n");
});

app.get("/admin/:siteId", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const siteId = req.params.siteId;
  if (!(await hasPermission(user, siteId))) {
    res.status(403).send("Forbidden");
    return;
  }

  // Create a token for this session (fake JWT format so Decap/netlify-cms accepts it)
  // Decap CMS checks for 3 parts header.payload.signature and checks exp in payload
  const base64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const header = base64Url({ alg: "HS256", typ: "JWT" });
  const payload = base64Url({
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year expiry
  });
  const signature = "dummy_signature";
  const token = `${header}.${payload}.${signature} `;

  await db("api_tokens").insert({
    token, // We store the full token string to match exactly
    user_id: user.id,
    site_id: siteId,
    created_at: new Date().toISOString()
  });

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).send("Site not found");
    return;
  }

  res.type("html").send(renderDecapShell(site, token));
});


app.get("/configs/:siteId.yml", async (req, res) => {
  console.log(`DEBUG: Config request for ${req.params.siteId}`);

  const auth = await getAuthInfo(req);
  if (!auth) {
    console.log("DEBUG: Config request unauthorized (no auth info)");
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const siteId = req.params.siteId;

  const permitted = await hasPermission(user, siteId);
  console.log(`DEBUG: Permission check for user ${user.email} on site ${siteId}: ${permitted} `);

  if (!permitted) {
    res.status(403).send("Forbidden");
    return;
  }

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    console.log(`DEBUG: Site ${siteId} not found in DB`);
    res.status(404).send("Not found");
    return;
  }

  const config = `backend: \n  name: git-gateway\n  api_root: ${API_BASE_URL}/.netlify/git\n  repo: ${site.github_repo}\n  branch: ${site.branch}\nmedia_folder: ${site.media_path}\npublic_folder: ${site.media_path}\ncollections: \n - name: "pages"\n    label: "Pages"\n    folder: "${site.content_path}"\n    create: true\n    fields: \n      - { label: "Title", name: "title", widget: "string" }\n      - { label: "Body", name: "body", widget: "markdown" }\n`;
  res.type("text/yaml").send(config);
});

(async () => {
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Portal listening on ${PORT} `);
  });
})();
