import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export abstract class GoogleTokenVerifier {
  /** Gecersiz token'da hata firlatir. */
  abstract verify(idToken: string): Promise<GoogleProfile>;
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** Google ID token'ini imza, aud, iss ve exp ile dogrular (SECURITY.md 2). */
export class JoseGoogleTokenVerifier extends GoogleTokenVerifier {
  constructor(private readonly clientId: string) {
    super();
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      audience: this.clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new Error('Google token eksik alan iceriyor');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
