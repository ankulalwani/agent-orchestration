/**
 * Local stand-in for OAuth providers, for tests: an OpenID Connect provider (discovery, authorize,
 * token, JWKS, userinfo) and GitHub's OAuth endpoints. It enforces what real providers enforce that
 * matters here: client credentials, the registered redirect URI, single-use codes and PKCE (S256).
 * `/authorize` signs in `nextUser` immediately, as if the person had approved the consent screen.
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export interface FakeIdp {
  url: string;
  clientId: string;
  clientSecret: string;
  nextUser: FakeUser;
  /** Next /authorize answers `error=access_denied` (the person clicked "Cancel"). */
  denyNext: boolean;
  /** Next token response carries an ID token signed by an unknown key. */
  forgeNextToken: boolean;
  /** Next ID token carries a different nonce (a token issued for another sign-in attempt). */
  wrongNonceNext: boolean;
  /** Issued codes that were redeemed, for assertions. */
  redeemed: number;
  close(): Promise<void>;
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const { privateKey: rogueKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: FakeUser; nonce?: string; challenge: string; redirectUri: string; kind: 'oidc' | 'github' }>();
  const tokens = new Map<string, FakeUser>();

  const idp: FakeIdp = {
    url: '',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    nextUser: { sub: 'u1', email: 'u1@example.com', email_verified: true, name: 'User One' },
    denyNext: false,
    forgeNextToken: false,
    wrongNonceNext: false,
    redeemed: 0,
    close: () => new Promise((r) => server.close(() => r())),
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const readForm = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(new URLSearchParams(b)));
    });

  const authorize = (u: URL, res: http.ServerResponse, kind: 'oidc' | 'github') => {
    const q = u.searchParams;
    const redirect = new URL(q.get('redirect_uri')!);
    if (q.get('client_id') !== idp.clientId) return json(res, 400, { error: 'unknown client' });
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'PKCE required' });
    if (idp.denyNext) {
      idp.denyNext = false;
      redirect.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(16).toString('hex');
      codes.set(code, { user: { ...idp.nextUser }, nonce: q.get('nonce') ?? undefined, challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, kind });
      redirect.searchParams.set('code', code);
    }
    redirect.searchParams.set('state', q.get('state')!);
    res.writeHead(302, { location: redirect.toString() }).end();
  };

  const token = async (req: http.IncomingMessage, res: http.ServerResponse, kind: 'oidc' | 'github') => {
    const f = await readForm(req);
    const c = codes.get(f.get('code') ?? '');
    codes.delete(f.get('code') ?? ''); // single use
    if (f.get('client_id') !== idp.clientId || f.get('client_secret') !== idp.clientSecret) return json(res, 401, { error: 'invalid_client' });
    if (!c || c.kind !== kind || c.redirectUri !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
    const verifier = f.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    idp.redeemed++;
    const accessToken = randomBytes(16).toString('hex');
    tokens.set(accessToken, c.user);
    if (kind === 'github') return json(res, 200, { access_token: accessToken, token_type: 'bearer', scope: 'read:user,user:email' });
    const forge = idp.forgeNextToken;
    idp.forgeNextToken = false;
    const nonce = idp.wrongNonceNext ? 'another-attempt' : c.nonce;
    idp.wrongNonceNext = false;
    const idToken = await new SignJWT({ ...c.user, nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(idp.url)
      .setAudience(idp.clientId)
      .setSubject(c.user.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(forge ? rogueKey : privateKey);
    json(res, 200, { access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: 300 });
  };

  const bearerUser = (req: http.IncomingMessage) => tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, idp.url);
    switch (u.pathname) {
      case '/.well-known/openid-configuration':
        return json(res, 200, {
          issuer: idp.url,
          authorization_endpoint: `${idp.url}/authorize`,
          token_endpoint: `${idp.url}/token`,
          jwks_uri: `${idp.url}/jwks`,
          userinfo_endpoint: `${idp.url}/userinfo`,
        });
      case '/jwks':
        return json(res, 200, { keys: [jwk] });
      case '/authorize':
        return authorize(u, res, 'oidc');
      case '/token':
        return token(req, res, 'oidc');
      case '/userinfo': {
        const user = bearerUser(req);
        return user ? json(res, 200, user) : json(res, 401, {});
      }
      // GitHub
      case '/login/oauth/authorize':
        return authorize(u, res, 'github');
      case '/login/oauth/access_token':
        return token(req, res, 'github');
      case '/api/user': {
        const user = bearerUser(req);
        return user ? json(res, 200, { id: Number(user.sub.replace(/\D/g, '')) || 42, login: user.name?.toLowerCase().replace(/\s/g, '') ?? 'octo', name: user.name ?? null }) : json(res, 401, {});
      }
      case '/api/user/emails': {
        const user = bearerUser(req);
        if (!user) return json(res, 401, {});
        return json(res, 200, [
          { email: `noreply-${user.sub}@users.noreply.github.com`, primary: false, verified: true },
          ...(user.email ? [{ email: user.email, primary: true, verified: user.email_verified !== false }] : []),
        ]);
      }
      default:
        json(res, 404, {});
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  idp.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return idp;
}
