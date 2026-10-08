import { Router } from 'express';

export function wellKnownRoutes({ config, keys }) {
  const router = Router();

  router.get('/.well-known/kpdd-auth', (_req, res) => {
    const base = config.issuer;
    res.set('Cache-Control', 'public, max-age=3600').json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      revocation_endpoint: `${base}/revoke`,
      introspection_endpoint: `${base}/introspect`,
      userinfo_endpoint: `${base}/me`,
      registration_endpoint: `${base}/apps/register`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['EdDSA'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  // Short cache: apps refetch on an unknown kid anyway, and rotation should spread fast.
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(keys.publicJwks());
  });

  return router;
}
