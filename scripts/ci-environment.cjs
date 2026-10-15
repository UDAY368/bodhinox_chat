const fs = require('node:fs');
const crypto = require('node:crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const database = process.env.CI_DATABASE_NAME || 'bodhinox_test';
const password = () => crypto.randomBytes(32).toString('hex');
const url = (role, secret) => `postgresql://${role}:${secret}@127.0.0.1:5432/${database}?sslmode=disable`;
const values = {
 MIGRATION_DATABASE_URL: url('postgres', 'ci-local-postgres'),
 DATABASE_URL: url('bodhinox_app', password()), AUTH_DATABASE_URL: url('bodhinox_auth', password()), WORKER_DATABASE_URL: url('bodhinox_worker', password()),
 AUTH_JWT_PRIVATE_KEY: privateKey, AUTH_JWT_PUBLIC_KEY: publicKey, AUTH_JWT_KID: 'ci-ephemeral', AUTH_JWT_ISSUER: 'http://localhost:3000', AUTH_JWT_AUDIENCE: 'bodhinox-chat-api',
 APP_URL: 'http://localhost:3000', ENCRYPTION_KEY: password(), AUTH_MFA_ENCRYPTION_KEY: password(), META_APP_SECRET: password()
};
Object.assign(values, { TEST_DATABASE_URL: values.MIGRATION_DATABASE_URL, TEST_APP_DATABASE_URL: values.DATABASE_URL, TEST_AUTH_DATABASE_URL: values.AUTH_DATABASE_URL, TEST_WORKER_DATABASE_URL: values.WORKER_DATABASE_URL });
const contents = Object.entries(values).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join('\n')+'\n';
fs.writeFileSync('.env.test', contents); fs.writeFileSync('.env.local', contents);
console.log('Prepared isolated CI database and ephemeral authentication keys.');
