async function listPermittedSites(db, user) {
  if (user.is_admin) {
    return db("sites")
      .where({ enabled: true })
      .orderBy("display_name");
  }

  return db("sites")
    .join("site_permissions", "sites.id", "site_permissions.site_id")
    .where({ "site_permissions.user_id": user.id, "sites.enabled": true })
    .select("sites.*")
    .orderBy("sites.display_name");
}

async function hasPermission(db, user, siteId) {
  if (user.is_admin) {
    const site = await db("sites").where({ id: siteId, enabled: true }).first();
    return Boolean(site);
  }

  const count = await db("site_permissions")
    .where({ user_id: user.id, site_id: siteId })
    .count("site_id as count")
    .first();

  return Boolean(count && Number(count.count) > 0);
}

module.exports = {
  listPermittedSites,
  hasPermission,
};
