async function revokePermission(email, siteId) {
  if (!confirm('Revoke access for ' + email + ' to ' + siteId + '?')) return;

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

async function editDomain(siteId, currentDomain) {
  const newDomain = prompt("Enter new custom domain (leave empty to remove):", currentDomain);
  if (newDomain === null) return;

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
  } catch (e) {
    alert('Network error');
  }
}

async function deleteSite(siteId, siteName) {
  if (!confirm('Are you sure you want to delete the site "' + siteName + '"? This will remove the CMS configuration but NOT the GitHub repository.')) return;

  try {
    const res = await fetch('/api/admin/sites/' + siteId, {
      method: 'DELETE'
    });
    if (res.ok || res.status === 204) {
      alert('Site deleted.');
      window.location.reload();
    } else {
      const err = await res.json();
      alert('Error: ' + (err.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Network error');
  }
}

async function resetRepository(siteId, siteName) {
  if (!confirm('Are you sure you want to reset the repository "' + siteName + '"? This will reinitialize the repository with fresh template files and overwrite all configuration files (but preserve the content folder if it exists as a backup).')) {
    return;
  }

  if (!confirm('This is a destructive action. Click OK again to confirm you want to reset "' + siteName + '".')) {
    return;
  }

  try {
    // Obtain a short-lived signed confirmation token from the server
    const tokenRes = await fetch('/api/admin/sites/' + siteId + '/reset-token');
    if (!tokenRes.ok) {
      alert('Could not obtain reset token: ' + (await tokenRes.text()));
      return;
    }
    const { confirmationToken } = await tokenRes.json();

    const res = await fetch('/api/admin/sites/' + siteId + '/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationToken })
    });
    if (res.ok) {
      alert('Repository reset started! GitHub Actions will rebuild the site shortly.');
      window.location.reload();
    } else {
      const err = await res.json();
      alert('Error: ' + (err.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Network error');
  }
}

async function changeTheme(siteId) {
  const theme = prompt("Enter theme name (e.g. 'cotes2020/jekyll-theme-chirpy', 'minima', 'slate'):", "minima");
  if (!theme) return;

  if (!confirm('This will overwrite _config.yml and commit new template files. Continue?')) return;

  try {
    const res = await fetch('/api/admin/sites/' + siteId + '/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: theme })
    });
    if (res.ok) {
      alert('Theme deployed and Pages configured! It may take a minute for GitHub actions to build.');
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
    } catch (err) {
      alert('Network error');
    }
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
    } catch (err) {
      alert('Network error');
    }
  });
});

