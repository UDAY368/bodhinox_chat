import { describe, expect, it } from 'vitest';
import { assertLocalPerfUrl, isolatedPerfEnv, perfDatabaseUrls } from '../../../scripts/perf/perf-env';

// The perf scripts (npm run perf:seed / perf:measure) reach only the local Docker perf database.
const local = (role: string, db = 'bodhinox_test') => `postgresql://${role}:pw@127.0.0.1:55432/${db}?sslmode=disable`;
const docker = {
  MIGRATION_DATABASE_URL: local('postgres'), DATABASE_URL: local('bodhinox_app'), AUTH_DATABASE_URL: local('bodhinox_auth'),
  WORKER_DATABASE_URL: local('bodhinox_worker'), PLATFORM_DATABASE_URL: local('bodhinox_platform'),
};

describe('[OPS-02] perf scripts database environment', () => {
  it('points every connection at bodhinox_perf on the local Docker database', () => {
    const urls = perfDatabaseUrls(docker);
    for (const value of Object.values(urls)) expect(new URL(value)).toMatchObject({ hostname: '127.0.0.1', port: '55432', pathname: '/bodhinox_perf' });
  });

  it('refuses a remote host, another port or another database, without echoing the URL', () => {
    for (const bad of ['postgresql://u:secret@db.example.net:55432/bodhinox_perf', 'postgresql://u:secret@127.0.0.1:5432/bodhinox_perf',
      'postgresql://u:secret@127.0.0.1:55432/railway', 'mysql://u:secret@127.0.0.1:55432/bodhinox_perf']) {
      let message = '';
      try { assertLocalPerfUrl('DATABASE_URL', bad); } catch (error) { message = (error as Error).message; }
      expect(message, bad).toMatch(/DATABASE_URL/);
      expect(message).not.toMatch(/secret|example\.net/);
    }
    expect(() => perfDatabaseUrls({ ...docker, DATABASE_URL: 'postgresql://u:p@db.example.net:55432/x' })).toThrow(/loopback/);
  });

  it('drops every inherited database variable and the remote-test override', () => {
    const env = isolatedPerfEnv({ DATABASE_URL: 'postgresql://prod', TEST_WORKER_DATABASE_URL: 'x', ALLOW_REMOTE_TEST_DB: '1', PATH: '/bin' },
      perfDatabaseUrls(docker));
    expect(env.PATH).toBe('/bin');
    expect(env.ALLOW_REMOTE_TEST_DB).toBeUndefined();
    expect(env.TEST_WORKER_DATABASE_URL).toBeUndefined();
    expect(new URL(env.DATABASE_URL!).pathname).toBe('/bodhinox_perf');
  });
});
