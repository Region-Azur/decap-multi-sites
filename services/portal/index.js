const crypto = require("crypto");
const express = require("express");
const { createDb, ensureSchema } = require("./shared/db");
const dns = require("dns");

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  console.log("DNS servers set to 8.8.8.8, 1.1.1.1");
} catch (e) {
  console.warn("Failed to set custom DNS servers:", e);
}

const PORT = Number(process.env.PORTAL_PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_OIDC_ISSUER = process.env.HITOBITO_OIDC_ISSUER || "";
const API_BASE_URL = process.env.API_BASE_URL || process.env.PORTAL_BASE_URL || "";

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
    const userInfoRes = await fetch(`${normalizedIssuer}/oauth/userinfo`, {
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

  const issuer = req.header("x-auth-request-issuer") || DEFAULT_OIDC_ISSUER;

  // Try X-Auth-Request headers first, then fall back to X-Forwarded headers
  const sub = req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader = req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername = req.header("x-auth-request-preferred-username") || req.header("x-forwarded-preferred-username");
  const accessToken = req.header("x-auth-request-access-token") || req.header("x-forwarded-access-token");

  let email = normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  let name = preferredUsername || sub || emailHeader;

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
// ...
async function getOrCreateUser(auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) {
    if (auth.accessToken && auth.issuer && (!existing.last_synced_at || Date.now() - new Date(existing.last_synced_at).getTime() > 24 * 60 * 60 * 1000)) {
      console.log(`DEBUG: Syncing user info for ${auth.email}`);
      const userInfo = await fetchUserInfo(auth.issuer, auth.accessToken);

      if (userInfo) {
        let newName = existing.name; // Default to existing
        const { nickname, given_name, family_name, name } = userInfo;

        if (nickname) {
          newName = nickname;
        } else if (given_name) {
          newName = given_name;
          if (family_name) {
            newName += ` ${family_name}`;
          }
        } else if (name) {
          newName = name;
        }

        await db("users").where({ id: existing.id }).update({
          name: newName,
          last_synced_at: new Date(),
        });

        return db("users").where({ id: existing.id }).first();
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

function renderAdminPanel(user, sites, users) {
  const sitesRows = sites.map(site => `
    <tr>
        <td>${site.id}</td>
        <td>${site.display_name}</td>
        <td>${site.github_repo}</td>
        <td>${site.enabled ? 'Yes' : 'No'}</td>
    </tr>
  `).join("");

  const usersRows = users.map(u => `
    <option value="${u.email}">${u.name} (${u.email})</option>
  `).join("");

  const sitesOptions = sites.map(s => `
    <option value="${s.id}">${s.display_name} (${s.id})</option>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Decap CMS Admin Panel</title>
  <style>
    body { font-family: sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1, h2 { border-bottom: 1px solid #ccc; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: bold; }
    input, select { padding: 8px; width: 100%; box-sizing: border-box; }
    button { padding: 10px 15px; background: #007bff; color: white; border: none; cursor: pointer; }
    button:hover { background: #0056b3; }
    .section { margin-bottom: 40px; background: #f9f9f9; padding: 20px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Admin Panel</h1>
  <p>Welcome, ${user.name} | <a href="/admin">Back to Site Picker</a></p>

  <div class="section">
    <h2>Sites</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>Name</th><th>Repo</th><th>Enabled</th></tr>
      </thead>
      <tbody>${sitesRows}</tbody>
    </table>

    <h3>Add New Site</h3>
    <form id="addSiteForm">
      <div class="form-group"><label>ID (e.g. my-site)</label><input type="text" name="id" required pattern="[a-z0-9-]+"></div>
      <div class="form-group"><label>Display Name</label><input type="text" name="display_name" required></div>
      <div class="form-group"><label>GitHub Repo (e.g. org/repo)</label><input type="text" name="github_repo" required></div>
      <div class="form-group"><label>Branch</label><input type="text" name="branch" value="main"></div>
      <button type="submit">Create Site</button>
    </form>
  </div>

  <div class="section">
    <h2>Permissions</h2>
    <p>Grant access to a user for a specific site.</p>
    <form id="addPermissionForm">
      <div class="form-group">
        <label>User</label>
        <select name="email" required>
            <option value="">Select User...</option>
            ${usersRows}
        </select>
      </div>
      <div class="form-group">
        <label>Site</label>
        <select name="site_id" required>
            <option value="">Select Site...</option>
            ${sitesOptions}
        </select>
      </div>
       <div class="form-group">
        <label>Role</label>
        <select name="role">
            <option value="editor">Editor</option>
            <option value="publisher">Publisher</option>
        </select>
      </div>
      <button type="submit">Grant Permission</button>
    </form>
  </div>

  <script>
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
        } else {
           const err = await res.json();
           alert('Error: ' + (err.error || 'Unknown error'));
        }
      } catch (err) { alert('Network error'); }
    });
  </script>
</body>
</html>`;
}

function renderDecapShell(siteId, token) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Decap CMS - ${siteId}</title>
    <link rel="cms-config-url" href="/configs/${siteId}.yml" type="text/yaml" />
    <script>window.CMS_MANUAL_INIT = true;</script>
  </head>
  <body>
    <script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>
    <script>
      document.addEventListener("DOMContentLoaded", async function() {
         if (window.CMS) {
            console.log("Initializing CMS...");
            
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
                    console.log("User data received:", user);
                    const userData = {
                        backendName: 'git-gateway',
                        token: '${token}', 
                        name: user.name,
                        email: user.email,
                        avatar_url: user.avatar_url,
                        login: user.login
                    };
                    localStorage.setItem('decap-cms-user', JSON.stringify(userData));
                    localStorage.setItem('netlify-cms-user', JSON.stringify(userData));
                    console.log("Auto-login credentials set in localStorage.");
                } else {
                    console.error("Fetch /api/user failed: " + await res.text());
                }
            } catch (e) {
                console.error("Auto-login exception", e);
            }

            window.CMS.init();
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

  // Fetch data from internal DB directly since we are in the trusted network/same DB
  // Alternatively, fetch from API if separation is strict, but direct DB is easier here 
  // since Portal and API share the DB code/access in this setup.
  const sites = await db("sites").orderBy("display_name");
  const users = await db("users").orderBy("name");

  res.type("html").send(renderAdminPanel(user, sites, users));
}

app.get("/", handleAdminHome);
app.get("/admin", handleAdminHome);
app.get("/admin-panel", handleAdminPanel);

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

  // Create a token for this session
  const token = crypto.randomUUID();
  await db("api_tokens").insert({
    token,
    user_id: user.id,
    created_at: new Date().toISOString()
  });

  res.type("html").send(renderDecapShell(siteId, token));
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
  console.log(`DEBUG: Permission check for user ${user.email} on site ${siteId}: ${permitted}`);

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

  const config = `backend:\n  name: git-gateway\n  api_root: ${API_BASE_URL}/api\n  repo: ${site.github_repo}\n  branch: ${site.branch}\nmedia_folder: ${site.media_path}\npublic_folder: ${site.media_path}\ncollections:\n  - name: "pages"\n    label: "Pages"\n    folder: "${site.content_path}"\n    create: true\n    fields:\n      - {label: "Title", name: "title", widget: "string"}\n      - {label: "Body", name: "body", widget: "markdown"}\n`;
  res.type("text/yaml").send(config);
});

(async () => {
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Portal listening on ${PORT}`);
  });
})();
