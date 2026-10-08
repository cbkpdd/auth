// Reads settings from the environment. `require` lists the variables a given
// entry point cannot run without; missing ones fail fast with one clear message.
export function loadConfig({ env = process.env, require = [] } = {}) {
  const missing = require.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')} (see .env.example)`);
  }

  let masterKey;
  if (env.AUTH_MASTER_KEY) {
    masterKey = Buffer.from(env.AUTH_MASTER_KEY, 'base64');
    if (masterKey.length !== 32) throw new Error('AUTH_MASTER_KEY must be 32 bytes, base64-encoded');
  }

  return {
    port: Number(env.PORT ?? 4000),
    databasePath: env.DATABASE_PATH ?? 'data/auth.db',
    issuer: env.AUTH_ISSUER,
    masterKey,
    dashWebhookSecret: env.DASH_WEBHOOK_SECRET,
    kpddApi: { url: env.KPDD_API_URL, key: env.KPDD_API_KEY },
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    emailApiKey: env.EMAIL_API_KEY,
  };
}
