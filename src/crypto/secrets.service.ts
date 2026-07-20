// src/crypto/secrets.service.ts
//
// Minimal AES-256-GCM encrypt/decrypt for provider credentials at rest.
// This is real, working Node.js crypto — not a placeholder — but it is
// NOT a production secrets-management setup on its own: the master key
// (ENCRYPTION_MASTER_KEY) must come from a real KMS (AWS KMS, GCP KMS,
// HashiCorp Vault) in production, not a plain environment variable. An
// env var is acceptable for local development only.

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getMasterKey(): Buffer {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_MASTER_KEY is not set');
  }
  // Expect a 32-byte key, base64-encoded.
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  }
  return buf;
}

/** Encrypts a plaintext string (typically JSON.stringify'd credentials)
 *  into a single Buffer: [12-byte IV][16-byte auth tag][ciphertext]. */
export function encrypt(plaintext: string): Buffer {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Reverses encrypt(). Throws if the auth tag doesn't verify — meaning
 *  the ciphertext was tampered with or the wrong key is in use. */
export function decrypt(encrypted: Buffer): string {
  const key = getMasterKey();
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = encrypted.subarray(IV_LENGTH + 16);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
