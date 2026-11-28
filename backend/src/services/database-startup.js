// Explicit opt-in for deployments against an already initialized database.
async function prepareDatabase(setupDatabase, env = process.env, prepareExistingDatabase) {
  if (env.SKIP_DATABASE_SETUP === '1') {
    console.log('[DB] Configuración general omitida. Verificando el esquema necesario para pedidos.');
    if (prepareExistingDatabase) await prepareExistingDatabase();
    return;
  }
  await setupDatabase();
}
module.exports = { prepareDatabase };
