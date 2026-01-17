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
      table.boolean("is_admin").notNullable().defaultTo(false);
      table.unique(["oidc_issuer", "oidc_sub"]);
    });
  }

  const hasSites = await db.schema.hasTable("sites");
  if (!hasSites) {
    await db.schema.createTable("sites", (table) => {
      table.string("id").primary();
      table.string("display_name").notNullable();
      table.string("github_repo").notNullable();
      table.string("branch").notNullable().defaultTo("main");
      table.string("content_path").notNullable().defaultTo("content/");
      table.string("media_path").notNullable().defaultTo("static/uploads/");
      table.boolean("enabled").notNullable().defaultTo(true);
    });
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
}

module.exports = {
  createDb,
  ensureSchema,
};
