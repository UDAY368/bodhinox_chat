// Local SMTP capture for end-to-end runs. A minimal plain SMTP listener on
// 127.0.0.1 (no TLS, no relay): it accepts every message and writes { to, data }
// to MAIL_DIR. global-setup starts it and global-teardown closes it; the dev
// server sends to it through SMTP_URL (scripts/e2e-server.cjs), so no mail can
// leave the machine during a test run.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Must equal the port scripts/e2e-server.cjs points SMTP_URL at. */
export const E2E_SMTP_PORT = Number(process.env.E2E_SMTP_PORT || 3125);
/** Captured mail, one JSON file per message, outside the project (the dev server watches it). */
export const MAIL_DIR = path.join(os.tmpdir(), 'bodhinox-e2e', 'mail');

export function startSmtpCapture(port = E2E_SMTP_PORT): Promise<net.Server> {
  fs.rmSync(MAIL_DIR, { recursive: true, force: true });
  fs.mkdirSync(MAIL_DIR, { recursive: true });
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let to: string[] = [];
    let data = '';
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 e2e-smtp ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          fs.writeFileSync(path.join(MAIL_DIR, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to, data }));
          to = []; data = '';
          reply('250 OK queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') { reply('250-e2e-smtp'); reply('250 8BITMIME'); }
        else if (verb === 'HELO') reply('250 e2e-smtp');
        else if (verb === 'MAIL') reply('250 OK');
        else if (verb === 'RCPT') { to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, '$1').toLowerCase()); reply('250 OK'); }
        else if (verb === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (verb === 'QUIT') { reply('221 Bye'); socket.end(); return; }
        else if (verb === 'RSET' || verb === 'NOOP') reply('250 OK');
        else reply('502 Command not implemented');
      }
    });
    socket.on('error', () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
