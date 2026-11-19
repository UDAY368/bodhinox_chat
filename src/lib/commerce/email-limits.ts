/** Client-safe limits of shop email (email-rules.ts holds the validators and pulls in server code). */
export const EMAIL_LIMITS = {
  name: 100, subject: 150, body: 5000, senderName: 80, senderAddress: 300, address: 254,
  /** Most recipients one campaign can have; a larger audience is narrowed with a segment. */
  recipients: 5000,
  /** Sends released per minute: recipient jobs are spread over time, so a large campaign never floods the SMTP server. */
  perMinute: 30,
} as const;
