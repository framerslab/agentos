import { generateKeyPairSync, sign } from 'node:crypto';
import { BrowserProofSchema, type BrowserProof } from '../contracts/index.js';
import { callProofPayload, proofKeyThumbprint, type CallProofInput } from '../CallCredentials.js';

/** Ephemeral CI-only key pair; no private key or live bearer is committed to a fixture. */
export function browserIdentity() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicKey = BrowserProofSchema.shape.publicKey.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  return {
    thumbprint: proofKeyThumbprint(publicKey),
    proof(input: CallProofInput): BrowserProof {
      return { publicKey, issuedAt: input.issuedAt, nonce: input.nonce,
        signature: sign('sha256', Buffer.from(callProofPayload(input)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    },
  };
}
