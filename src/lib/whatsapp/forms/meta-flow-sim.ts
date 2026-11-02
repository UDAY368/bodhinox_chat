/** Test helpers: WhatsApp's side of the forms endpoint encryption. Not used by app code. */

import crypto from 'node:crypto';

/** What WhatsApp does on its side: fresh AES key and IV, key wrapped with our public key. */
export function sealLikeMeta(payload: unknown, publicKeyPem: string) {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const wrapped = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
  return {
    body: { encrypted_aes_key: wrapped.toString('base64'), encrypted_flow_data: sealed.toString('base64'), initial_vector: iv.toString('base64') },
    aesKey,
    iv,
  };
}

/** WhatsApp reading our response: same key, every IV bit flipped, tag at the end. */
export function openLikeMeta(response: string, aesKey: Buffer, iv: Buffer): unknown {
  const sealed = Buffer.from(response, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map((b) => b ^ 0xff)));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8'));
}
