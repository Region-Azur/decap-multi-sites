const knex = require("knex");

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (databaseUrl.startsWith("sqlite:")) {
    const url = new URL(databaseUrl);
    const filename = decodeURIComponent(url.pathname || "/data/cms.sqlite");
    return {
      client: "sqlite3",
      connection: {
        filename,
      },
      useNullAsDefault: true,
    };
  }

  if (databaseUrl.startsWith("mysql:")) {
    const url = new URL(databaseUrl);
    return {
      client: "mysql2",
      connection: {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace("/", ""),
      },
    };
  }

  throw new Error(`Unsupported DATABASE_URL: ${databaseUrl}`);
}

function createDb(databaseUrl) {
  return knex(parseDatabaseUrl(databaseUrl));
}

async function ensureSchema(db) {
  const hasUsers = await db.schema.hasTable("users");
  if (!hasUsers) {
    await db.schema.createTable("users", (table) => {
      table.string("id").primary();
      table.string("oidc_issuer").notNullable();
      table.string("oidc_sub").notNullable();
      table.string("email").notNullable();
      table.string("name").notNullable();
      table.dateTime("last_synced_at").nullable();
      table.boolean("is_admin").notNullable().defaultTo(false);
      table.unique(["oidc_issuer", "oidc_sub"]);
    });
  } else {
    // Migration: add last_synced_at if it doesn't exist
    const hasLastSynced = await db.schema.hasColumn("users", "last_synced_at");
    if (!hasLastSynced) {
      await db.schema.table("users", (table) => {
        table.dateTime("last_synced_at").nullable();
      });
    }
  }

  const hasSites = await db.schema.hasTable("sites");
  if (!hasSites) {
    await db.schema.createTable("sites", (table) => {
      table.string("id").primary();
      table.string("display_name").notNullable();
      table.string("github_repo").notNullable();
      table.string("branch").notNullable().defaultTo("main");
      table.string("content_path").notNullable().defaultTo("content");
      table.string("media_path").notNullable().defaultTo("static/uploads/");
      table.string("domain").nullable(); // Custom domain support
      table.string("page_title").nullable();
      table.string("suptitle").nullable();
      table.string("brand_icon").nullable();
      table.string("favicon").nullable();
      table.boolean("enabled").notNullable().defaultTo(true);
    });
  } else {
    // Migration: Add 'domain' column if it doesn't exist
    const hasDomain = await db.schema.hasColumn("sites", "domain");
    if (!hasDomain) {
      await db.schema.table("sites", (table) => {
        table.string("domain").nullable();
      });
    }

    const hasPageTitle = await db.schema.hasColumn("sites", "page_title");
    if (!hasPageTitle) {
      await db.schema.table("sites", (table) => {
        table.string("page_title").nullable();
      });
    }

    const hasSuptitle = await db.schema.hasColumn("sites", "suptitle");
    if (!hasSuptitle) {
      await db.schema.table("sites", (table) => {
        table.string("suptitle").nullable();
      });
    }

    const hasBrandIcon = await db.schema.hasColumn("sites", "brand_icon");
    if (!hasBrandIcon) {
      await db.schema.table("sites", (table) => {
        table.string("brand_icon").nullable();
      });
    }

    const hasFavicon = await db.schema.hasColumn("sites", "favicon");
    if (!hasFavicon) {
      await db.schema.table("sites", (table) => {
        table.string("favicon").nullable();
      });
    }
    const hasTheme = await db.schema.hasColumn("sites", "theme");
    if (!hasTheme) {
      await db.schema.table("sites", (table) => {
        table.string("theme").nullable().defaultTo("chirpy");
      });
    }
  }

  const hasPermissions = await db.schema.hasTable("site_permissions");
  if (!hasPermissions) {
    await db.schema.createTable("site_permissions", (table) => {
      table.string("user_id").notNullable();
      table.string("site_id").notNullable();
      table.string("role").nullable();
      table.primary(["user_id", "site_id"]);
    });
  }

  const hasApiTokens = await db.schema.hasTable("api_tokens");
  if (!hasApiTokens) {
    await db.schema.createTable("api_tokens", (table) => {
      table.string("token").primary();
      table.string("user_id").notNullable();
      table.string("site_id").nullable(); // Links token to a specific site context
      table.string("created_at").notNullable();
    });
  } else {
    const hasSiteId = await db.schema.hasColumn("api_tokens", "site_id");
    if (!hasSiteId) {
      await db.schema.table("api_tokens", (table) => {
        table.string("site_id").nullable();
      });
    }
  }
}

module.exports = {
  createDb,
  ensureSchema,
};
