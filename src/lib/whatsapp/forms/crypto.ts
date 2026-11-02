/**
 * End-to-end encryption for the WhatsApp Forms data endpoint.
 *
 * Meta encrypts every endpoint request with a fresh AES-128 key, wraps that
 * key with the business public key (RSA-OAEP, SHA-256) and appends the
 * 16-byte GCM tag to the ciphertext. The response is encrypted with the same
 * AES key and the request IV with every bit flipped.
 *
 * Nothing here logs: keys and decrypted payloads are customer secrets.
 */

import crypto from 'node:crypto';

const AES_ALGORITHM = 'aes-128-gcm';
const AES_KEY_BYTES = 16;
const TAG_BYTES = 16;

export interface EncryptedFormsRequest {
  encrypted_aes_key: string;
  encrypted_flow_data: string;
  initial_vector: string;
}

export interface DecryptedFormsRequest {
  decrypted: Record<string, unknown>;
  aesKey: Buffer;
  iv: Buffer;
}

/** Raised for any request we cannot decrypt; the endpoint answers HTTP 421. */
export class FormsDecryptError extends Error {
  constructor() {
    super('Forms request could not be decrypted');
    this.name = 'FormsDecryptError';
  }
}

/** A fresh RSA-2048 pair: the public half goes to Meta, the private half stays encrypted at rest. */
export function generateFormsKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function isEncryptedFormsRequest(body: unknown): body is EncryptedFormsRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return ['encrypted_aes_key', 'encrypted_flow_data', 'initial_vector'].every((k) => typeof b[k] === 'string' && (b[k] as string).length > 0);
}

export function decryptRequest(body: EncryptedFormsRequest, privateKeyPem: string): DecryptedFormsRequest {
  try {
    const aesKey = crypto.privateDecrypt(
      { key: crypto.createPrivateKey(privateKeyPem), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(body.encrypted_aes_key, 'base64'),
    );
    if (aesKey.length !== AES_KEY_BYTES) throw new FormsDecryptError();
    const iv = Buffer.from(body.initial_vector, 'base64');
    const sealed = Buffer.from(body.encrypted_flow_data, 'base64');
    if (iv.length === 0 || sealed.length <= TAG_BYTES) throw new FormsDecryptError();
    const decipher = crypto.createDecipheriv(AES_ALGORITHM, aesKey, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const decrypted: unknown = JSON.parse(plain);
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) throw new FormsDecryptError();
    return { decrypted: decrypted as Record<string, unknown>, aesKey, iv };
  } catch {
    // One error type whatever failed: the reason could leak key material through timing or messages.
    throw new FormsDecryptError();
  }
}

/** Encrypts a response body for Meta: AES-128-GCM, flipped IV, tag appended, base64. */
export function encryptResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((byte) => byte ^ 0xff));
  const cipher = crypto.createCipheriv(AES_ALGORITHM, aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
