/**
 * Order notice templates (Phase 9, design §3 T6): the approved WhatsApp
 * template each order notice uses outside the 24-hour window. Dispatched,
 * delivered and feedback need a UTILITY template; the reorder reminder
 * (repeat_purchase, D13) needs a MARKETING one.
 *
 * Runs in the caller's live session (withTenant, app role): agents read,
 * admins write (RLS on order_notice_templates enforces the same rule). Every
 * change is audited with the kind only. The send job re-checks approval and
 * category at send time, so a template that later loses approval is refused
 * there.
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { NOTICE_TEMPLATE_CATEGORY, NOTICE_TEMPLATE_KINDS, type NoticeTemplateKind } from './order-followup';

export type NoticeTemplateErrorCode = 'invalid' | 'template_not_found' | 'wrong_category';

export class NoticeTemplateError extends Error {
  readonly status: number;
  constructor(readonly code: NoticeTemplateErrorCode) {
    super(code === 'wrong_category' ? getT('Validation.shipments')('wrong_category') : getT('Commerce.noticeTemplates.errors')(code));
    this.name = 'NoticeTemplateError';
    this.status = 400;
  }
}

export function noticeTemplateErrorResponse(error: unknown): NextResponse {
  if (error instanceof NoticeTemplateError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

export interface NoticeTemplateSetting {
  kind: NoticeTemplateKind;
  category: 'UTILITY' | 'MARKETING';
  template_name: string | null;
  language: string | null;
  /** The chosen template is still an approved template of the right category. */
  usable: boolean;
}

export interface NoticeTemplateOption {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING';
}

export interface NoticeTemplatesView {
  settings: NoticeTemplateSetting[];
  /** Approved UTILITY and MARKETING templates to choose from. */
  options: NoticeTemplateOption[];
}

export const isNoticeTemplateKind = (value: unknown): value is NoticeTemplateKind =>
  typeof value === 'string' && (NOTICE_TEMPLATE_KINDS as readonly string[]).includes(value);

export interface NoticeTemplateInput {
  kind: NoticeTemplateKind;
  /** null clears the setting. */
  template: { name: string; language: string } | null;
}

/** Parse a PUT body { kind, template_name, language } (both null to clear). */
export function parseNoticeTemplateInput(raw: unknown): NoticeTemplateInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NoticeTemplateError('invalid');
  const b = raw as Record<string, unknown>;
  if (!isNoticeTemplateKind(b.kind)) throw new NoticeTemplateError('invalid');
  if (b.template_name === null || b.template_name === undefined || b.template_name === '') {
    return { kind: b.kind, template: null };
  }
  const name = typeof b.template_name === 'string' ? b.template_name.trim() : '';
  const language = typeof b.language === 'string' ? b.language.trim() : '';
  if (name.length < 1 || name.length > 512 || language.length < 2 || language.length > 15) throw new NoticeTemplateError('invalid');
  return { kind: b.kind, template: { name, language } };
}

const upper = (value: string | null) => String(value ?? '').toUpperCase();

export async function getNoticeTemplates(ctx: TenantContext): Promise<NoticeTemplatesView> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: string; name: string; language: string; status: string | null; category: string | null }[]>`
      SELECT n.kind, n.template_name AS name, n.language,
        (SELECT m.status FROM message_templates m WHERE m.account_id=n.account_id AND m.name=n.template_name
          AND lower(m.language)=lower(n.language) ORDER BY (upper(coalesce(m.status,''))='APPROVED') DESC LIMIT 1) AS status,
        (SELECT m.category FROM message_templates m WHERE m.account_id=n.account_id AND m.name=n.template_name
          AND lower(m.language)=lower(n.language) ORDER BY (upper(coalesce(m.status,''))='APPROVED') DESC LIMIT 1) AS category
      FROM order_notice_templates n WHERE n.account_id=${ctx.accountId}::uuid`;
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    const options = await tx.$queryRaw<{ name: string; language: string; category: string }[]>`
      SELECT DISTINCT name, language, upper(category) AS category FROM message_templates
      WHERE account_id=${ctx.accountId}::uuid AND upper(coalesce(status,''))='APPROVED' AND language IS NOT NULL
        AND upper(coalesce(category,'')) IN ('UTILITY','MARKETING')
      ORDER BY name, language LIMIT 500`;
    return {
      settings: NOTICE_TEMPLATE_KINDS.map((kind) => {
        const row = byKind.get(kind);
        const category = NOTICE_TEMPLATE_CATEGORY[kind];
        return {
          kind, category, template_name: row?.name ?? null, language: row?.language ?? null,
          usable: !!row && upper(row.status) === 'APPROVED' && upper(row.category) === category,
        };
      }),
      options: options.map((o) => ({ name: o.name, language: o.language, category: o.category as 'UTILITY' | 'MARKETING' })),
    };
  });
}

/**
 * Set or clear one kind's template (admins; RLS refuses anyone else). The
 * template must exist in the workspace with the kind's category; approval is
 * checked again at send time.
 */
export async function saveNoticeTemplate(ctx: TenantContext & { userId: string }, input: NoticeTemplateInput): Promise<NoticeTemplatesView> {
  await withTenant(ctx, async (tx) => {
    if (input.template) {
      const [template] = await tx.$queryRaw<{ category: string | null }[]>`
        SELECT category FROM message_templates WHERE account_id=${ctx.accountId}::uuid AND name=${input.template.name}
          AND lower(language)=lower(${input.template.language})
        ORDER BY (upper(coalesce(status,''))='APPROVED') DESC LIMIT 1`;
      if (!template) throw new NoticeTemplateError('template_not_found');
      if (upper(template.category) !== NOTICE_TEMPLATE_CATEGORY[input.kind]) throw new NoticeTemplateError('wrong_category');
      await tx.$executeRaw`INSERT INTO order_notice_templates(account_id,kind,template_name,language)
        VALUES(${ctx.accountId}::uuid,${input.kind},${input.template.name},${input.template.language})
        ON CONFLICT (account_id,kind) DO UPDATE SET template_name=EXCLUDED.template_name, language=EXCLUDED.language`;
    } else {
      await tx.$executeRaw`DELETE FROM order_notice_templates WHERE account_id=${ctx.accountId}::uuid AND kind=${input.kind}`;
    }
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.notice_template_updated',${ctx.accountId},
        ${JSON.stringify({ kind: input.kind, cleared: !input.template })}::jsonb)`;
  });
  return getNoticeTemplates(ctx);
}
