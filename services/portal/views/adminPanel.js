const { getFaviconHTML } = require("../../shared/favicon");

function renderAdminPanel(user, sites, permissions, allUsers) {
  const siteRows = sites.map(s => {
    const [owner, repo] = s.github_repo.split('/');
    const dnsTarget = `${owner}.github.io`;
    let publishedUrl = `https://${owner}.github.io/${repo}`;
    if (s.domain) {
      publishedUrl = `https://${s.domain}`;
    }

    let dnsButton = "";
    if (s.domain) {
      const host = s.domain.startsWith('www') ? 'www' : '@';
      const msg = `DNS Setup for ${s.domain}:\\n\\nType: CNAME\\nHost: ${host}\\nValue: ${dnsTarget}`;
      dnsButton = `<button onclick="alert('${msg}')">DNS Info</button>`;
    }

    return `<tr>
      <td><a href="/sites/${s.id}" target="_blank">${s.display_name}</a></td>
      <td>${s.github_repo}</td>
      <td>
        ${s.domain || '<em style="color:#888">None</em>'} 
        <button onclick="editDomain('${s.id}', '${s.domain || ''}')" style="font-size:0.8em; margin-left:5px;">Edit</button>
      </td>
      <td>
        <a href="${publishedUrl}" target="_blank" style="margin-right:10px;">View Site</a>
        <button onclick="changeTheme('${s.id}')" style="font-size:0.8em;">Theme</button>
        ${dnsButton}
        <button onclick="resetRepository('${s.id}', '${s.display_name}')" style="font-size:0.8em; margin-left:5px; color:#d97706; border: 1px solid #d97706; background:#fff;" title="Reset repository to initial state">Reset</button>
        <button onclick="deleteSite('${s.id}', '${s.display_name}')" style="font-size:0.8em; margin-left:5px; color:red; border: 1px solid red; background:#fff;">Delete</button>
      </td>
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
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CMS Admin Panel</title>
  ${getFaviconHTML()}
  <link rel="stylesheet" href="/css/admin.css">
</head>
<body>
  <div class="panel-top">
    <h1>CMS Admin Panel</h1>
    <a class="back-link" href="/sites">← Back to Sites</a>
  </div>
  <p>Logged in as: <strong>${user.name}</strong> (${user.email})</p>

  <h2>Sites</h2>
  <table>
    <tr><th>Name</th><th>Repo</th><th>Domain</th><th>Actions</th></tr>
    ${siteRows}
  </table>

  <h3>Add New Site</h3>
  <form id="addSiteForm">
    <div class="form-group">
      <label for="site_id">ID (Slug)</label>
      <input id="site_id" name="id" required placeholder="my-site">
    </div>
    <div class="form-group">
      <label for="display_name">Display Name</label>
      <input id="display_name" name="display_name" required placeholder="My Site">
    </div>
    <div class="form-group">
      <label for="github_repo">GitHub Repo (owner/repo)</label>
      <input id="github_repo" name="github_repo" required placeholder="owner/repo" 
             title="Format: owner/repo (no spaces)" 
             pattern="[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+" 
             onchange="this.value = this.value.trim()">
    </div>
    <div class="form-group">
      <label for="branch">Branch</label>
      <input id="branch" name="branch" value="main">
    </div>
    <div class="form-group">
      <label for="theme">Theme</label>
      <select id="theme" name="theme">
        <option value="minima">Minima (Default)</option>
        <option value="chirpy">Chirpy (Advanced)</option>
        <option value="slate">Slate (Dark)</option>
        <option value="cayman">Cayman (Blue)</option>
        <option value="merlot">Merlot (Red)</option>
        <option value="midnight">Midnight (Dark)</option>
        <option value="time-machine">Time Machine (Retro)</option>
      </select>
    </div>
    <div class="form-group">
      <label for="domain">Custom Domain (Optional)</label>
      <input id="domain" name="domain" placeholder="www.example.com">
      <small>Will auto-configure CNAME in repo</small>
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
      <label for="user_email">User</label>
      <select id="user_email" name="email" required>
        <option value="">Select User...</option>
        ${userOptions}
      </select>
    </div>
    <div class="form-group">
      <label for="site_id_perm">Site ID</label>
      <select id="site_id_perm" name="site_id" required>
        <option value="">Select Site...</option>
        ${siteOptions}
      </select>
    </div>
    <button type="submit">Grant Access</button>
  </form>

  <script src="/js/adminPanel.js"></script>
</body>
</html>`;
}

module.exports = { renderAdminPanel };

