/**
 * Singleton database instance shared across all API modules.
 */
const { createDb } = require("./shared/db");
const config = require("./config");

const db = createDb(config.DATABASE_URL);

module.exports = db;

