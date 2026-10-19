import { afterEach, describe, expect, it, vi } from 'vitest';
const smtp = vi.hoisted(() => ({ verify: vi.fn(), close: vi.fn(), sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => smtp } }));
import { checkAuthEmailTransport, sendAuthEmail } from './email';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); vi.restoreAllMocks(); });
describe('safe authentication mail diagnostics', () => {
  it('reports actionable delivery failures while keeping provider responses out of logs', async () => {
    vi.stubEnv('SMTP_URL', 'smtps://test.invalid');
    vi.stubEnv('AUTH_EMAIL_FROM', 'test@example.invalid');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    smtp.sendMail.mockRejectedValue({ code: 'EAUTH', responseCode: 535, message: 'private credentials' });
    await expect(sendAuthEmail({ to: 'owner@example.invalid', text: 'Test' })).rejects.toMatchObject({ code: 'email_delivery_failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private credentials');
    expect(smtp.close).toHaveBeenCalledOnce();
  });
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
