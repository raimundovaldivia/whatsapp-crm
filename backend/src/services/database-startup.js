// Explicit opt-in for deployments against an already initialized database.
async function prepareDatabase(setupDatabase, env = process.env) {
  if (env.SKIP_DATABASE_SETUP === '1') {
    console.log('[DB] Preparación/migraciones omitidas por configuración explícita.');
    return;
  }
  await setupDatabase();
}
module.exports = { prepareDatabase };
