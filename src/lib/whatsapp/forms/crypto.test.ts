import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { openLikeMeta, sealLikeMeta } from './meta-flow-sim';
import { decryptRequest, encryptResponse, FormsDecryptError, generateFormsKeyPair, isEncryptedFormsRequest } from './crypto';

const keys = generateFormsKeyPair();

describe('forms endpoint encryption', () => {
  it('generates an RSA-2048 PEM pair', () => {
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(crypto.createPublicKey(keys.publicKeyPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('round-trips a request and its response the way WhatsApp does', () => {
    const request = { version: '3.0', action: 'INIT', flow_token: 't'.repeat(43) };
    const meta = sealLikeMeta(request, keys.publicKeyPem);
    const opened = decryptRequest(meta.body, keys.privateKeyPem);
    expect(opened.decrypted).toEqual(request);
    expect(opened.aesKey.equals(meta.aesKey)).toBe(true);
    expect(opened.iv.equals(meta.iv)).toBe(true);

    const response = { screen: 'FIRST', data: { name: 'Ana' } };
    expect(openLikeMeta(encryptResponse(response, opened.aesKey, opened.iv), meta.aesKey, meta.iv)).toEqual(response);
  });

  it('refuses a request sealed for another key, or tampered with', () => {
    const other = generateFormsKeyPair();
    const meta = sealLikeMeta({ action: 'ping' }, other.publicKeyPem);
    expect(() => decryptRequest(meta.body, keys.privateKeyPem)).toThrow(FormsDecryptError);

    const good = sealLikeMeta({ action: 'ping' }, keys.publicKeyPem);
    const data = Buffer.from(good.body.encrypted_flow_data, 'base64');
    data[0] ^= 1;
    expect(() => decryptRequest({ ...good.body, encrypted_flow_data: data.toString('base64') }, keys.privateKeyPem)).toThrow(FormsDecryptError);
    expect(() => decryptRequest({ ...good.body, encrypted_aes_key: 'AAAA' }, keys.privateKeyPem)).toThrow(FormsDecryptError);
  });

  it('recognises only the encrypted request shape', () => {
    expect(isEncryptedFormsRequest(sealLikeMeta({}, keys.publicKeyPem).body)).toBe(true);
    expect(isEncryptedFormsRequest({ encrypted_aes_key: 'a', encrypted_flow_data: 'b' })).toBe(false);
    expect(isEncryptedFormsRequest(null)).toBe(false);
  });
});
