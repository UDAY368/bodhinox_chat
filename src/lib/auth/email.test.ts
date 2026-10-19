import { afterEach, describe, expect, it, vi } from 'vitest';
const smtp = vi.hoisted(() => ({ verify: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => smtp } }));
import { checkAuthEmailTransport } from './email';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('safe authentication mail diagnostics', () => {
  it('requires explicit delivery configuration', async () => {
    vi.stubEnv('SMTP_URL', '');
    await expect(checkAuthEmailTransport()).rejects.toMatchObject({ code: 'email_unavailable' });
  });
  it('authenticates without sending a message', async () => {
    vi.stubEnv('SMTP_URL', 'smtps://test.invalid');
    vi.stubEnv('AUTH_EMAIL_FROM', 'test@example.invalid');
    smtp.verify.mockResolvedValue(true);
    expect(await checkAuthEmailTransport()).toEqual({ configured: true, connected: true });
    expect(smtp.close).toHaveBeenCalledOnce();
  });
  it('returns only a safe error code, never provider responses or credentials', async () => {
    vi.stubEnv('SMTP_URL', 'smtps://test.invalid');
    vi.stubEnv('AUTH_EMAIL_FROM', 'test@example.invalid');
    smtp.verify.mockRejectedValue({ code: 'EAUTH', message: 'private credentials', response: 'private response' });
    expect(await checkAuthEmailTransport()).toEqual({ configured: true, connected: false, code: 'EAUTH' });
    expect(smtp.close).toHaveBeenCalledOnce();
  });
});
