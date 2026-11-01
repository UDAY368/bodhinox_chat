# Transactional email on Railway Pro

Bodhinox Chat currently uses Nodemailer SMTP for signup verification, password reset, invitation-related account onboarding, and verified email changes. Railway Pro permits outbound SMTP, but Railway does **not** provide the SMTP relay or sender identity. You need a relay account and a verified sender domain. [Railway email delivery policy](https://docs.railway.com/networking/outbound-networking).

## Recommended provider: Resend SMTP

Resend offers an SMTP relay and a free transactional-email allowance; check its [current pricing](https://resend.com/pricing) before relying on a quota. Any reputable SMTP relay can work with the existing `SMTP_URL` transport.

For this project, the owner controls **`bodhinox.com`** and **`bodhinox.in`** and manages both DNS zones at **GoDaddy**. The website hostname `www.bodhinox.com` is separate from the sender domain. Both domains can be verified in Resend, while the current app uses one configured sender: `no-reply@bodhinox.com`. Preserve existing website records and any existing mail routing; add only the exact DNS records Resend requests. If Resend detects a conflict with a current SPF or return-path record, resolve it using the provider's guidance before changing a live record.

1. Sign in to your own [Resend account](https://resend.com/signup). In **Domains**, add `bodhinox.com` and `bodhinox.in`. Resend displays DNS record types, host names and values for verification/sending. In **GoDaddy → Domain Portfolio → each domain → DNS → Add New Record**, add each record with the values Resend displays for that specific domain. GoDaddy's **Name** field takes the host/prefix, not a second copy of the domain; use `@` only when Resend asks for the root. Wait until Resend marks both domains verified. Do not invent SPF/DKIM values or overwrite existing website/mail records. [Resend domain verification](https://resend.com/changelog/domain-verification-events), [GoDaddy DNS instructions](https://www.godaddy.com/en-uk/help/manage-dns-records-680).
2. Use a **sending-only** API key scoped to the verified domains if your Resend plan supports it. Keep it in the provider's secret store/your password manager. Never put it in GitHub, documentation or screenshots. [Resend key permissions](https://resend.com/changelog/new-api-key-permissions).
3. In Railway, open **Bodhinox_Chat → production → Bodhinox-Web → Variables**. Add:

   ```text
   SMTP_URL=smtps://resend:YOUR_URL_ENCODED_API_KEY@smtp.resend.com:465
   AUTH_EMAIL_FROM=Bodhinox Chat <no-reply@bodhinox.com>
   ```

   Replace both placeholders. If your provider password contains `@`, `:`, `/`, `?`, `#`, `%` or similar URL-significant characters, percent-encode it before embedding it in `SMTP_URL`. `smtps://` on port 465 uses TLS from the start. Resend specifies host `smtp.resend.com`, username `resend`, and the API key as the password. [Resend SMTP settings](https://resend.com/changelog/smtp-service), [Nodemailer SMTP URL format](https://nodemailer.com/smtp).
4. Check that Railway's `APP_URL`, `NEXT_PUBLIC_SITE_URL`, and `AUTH_JWT_ISSUER` match the public HTTPS application origin. The verification and reset links use `APP_URL`. Railway variable changes redeploy the web service; wait for a successful deployment and healthy `/api/health`.
5. At the production `/signup`, create a new **test owner using an inbox you control**. Confirm the email arrives, opens the production `/auth/callback`, and permits login. Then test **Forgot password**, a team invitation to a second address, and MFA setup. Check the provider's delivery logs if mail does not arrive.

Only **Bodhinox-Web** needs the SMTP credentials for the current authentication mail path. The worker does not send these emails. Do not copy SMTP credentials into shared Railway variables or the worker unless a later implementation explicitly needs them.

## Alternative SMTP relay

For another provider, use its documented host, port, username and password in the same URL format:

```text
smtps://USERNAME:URL_ENCODED_PASSWORD@SMTP_HOST:465
smtp://USERNAME:URL_ENCODED_PASSWORD@SMTP_HOST:587
```

Confirm whether the provider uses implicit TLS (typically port 465) or STARTTLS (typically port 587); keep certificate validation enabled. The `AUTH_EMAIL_FROM` domain/address must be permitted by that provider. Never use a local-only mail catcher or an unverified sender for real account emails.

## Present state

On 15 October 2026, the three Resend DNS records were added to each of `bodhinox.com` and `bodhinox.in` in GoDaddy. Public DNS resolves them and Resend reports **both domains verified**. The SMTP transport authenticated successfully from the ignored local `.env.local`; `SMTP_URL` and `AUTH_EMAIL_FROM` are set only on the Railway **Bodhinox-Web** service, whose redeploy succeeded. The Railway-generated web domain was routed to the app's listening port `8080`; `/api/health` returned HTTP 200. No credential is stored in this document or Git. Production signup and delivery still need an end-to-end check using an inbox the owner controls. The application currently has one sender configured; switching to `.in` would require changing `AUTH_EMAIL_FROM` or adding sender selection in a future implementation.
