/**
 * A store page (store plan Phase 2): About, Contact and FAQ from the shop's
 * own text, and Shipping, Returns, Privacy and Terms written from the store
 * settings (shipping rates, cash on delivery, return window, legal name and
 * address) with the shop's optional note below. Pure: the public page and
 * the theme editor's preview share it.
 */
import type { ShopPolicyFacts } from '@/lib/commerce/public-shop';
import type { PolicySlug, ShopContent, ShopPageSlug } from '@/lib/commerce/shop-sections';
import { formatMoney } from '@/lib/commerce/money';
import { FaqList } from './shop-sections';
import type { ShopT } from './shop-link';

const heading = { fontFamily: 'var(--shop-font-heading)' } as const;

function Paragraphs({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}</>;
}

/** The generated text of a policy page, as paragraphs. */
export function policyParagraphs(slug: PolicySlug, facts: ShopPolicyFacts, shopName: string, t: ShopT, locale: string): string[] {
  const money = (minor: number) => (facts.currency ? formatMoney(minor, facts.currency, locale) : String(minor));
  const seller = facts.legalName ?? shopName;
  switch (slug) {
    case 'shipping': {
      const lines = [t('policy.shippingIntro')];
      if (!facts.shippingRates.length) lines.push(t('policy.noRates'));
      for (const r of facts.shippingRates) {
        if (r.feeMinor === 0 && r.minSubtotalMinor > 0) lines.push(t('policy.rateFreeOver', { name: r.name, min: money(r.minSubtotalMinor) }));
        else if (r.feeMinor === 0) lines.push(t('policy.rateFree', { name: r.name }));
        else if (r.minSubtotalMinor > 0) lines.push(t('policy.rateOver', { name: r.name, fee: money(r.feeMinor), min: money(r.minSubtotalMinor) }));
        else lines.push(t('policy.rate', { name: r.name, fee: money(r.feeMinor) }));
      }
      if (facts.cod.enabled) lines.push(facts.cod.feeMinor > 0 ? t('policy.codFee', { fee: money(facts.cod.feeMinor) }) : t('policy.cod'));
      return lines;
    }
    case 'refund':
      return facts.returnWindowDays > 0
        ? [t('policy.refund', { days: facts.returnWindowDays }), t('policy.refundMoney')]
        : [t('policy.noReturns'), t('policy.refundMoney')];
    case 'privacy':
      return [t('policy.privacy', { shop: seller }), t('policy.privacyRights')];
    case 'terms':
      return [t('policy.terms', { shop: seller }), t('policy.termsCancel')];
  }
}

export function ShopPageView({ slug, content, facts, shopName, t, locale, contactDetails }: {
  slug: ShopPageSlug; content: ShopContent; facts: ShopPolicyFacts; shopName: string; t: ShopT; locale: string; contactDetails: boolean;
}) {
  const title = slug === 'about' ? content.pages.about.title : slug === 'contact' ? content.pages.contact.title
    : slug === 'faq' ? content.pages.faq.title : null;
  const contact = content.footer.contact;
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 leading-relaxed">
      <h1 className="text-2xl font-semibold @2xl:text-3xl" style={heading}>{title ?? t(`pages.${slug}`)}</h1>
      {slug === 'about' && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL */}
          {content.pages.about.image && <img src={content.pages.about.image} alt="" className="aspect-[16/9] w-full rounded-[var(--shop-radius)] object-cover" />}
          {content.pages.about.body && <Paragraphs text={content.pages.about.body} />}
        </>
      )}
      {slug === 'contact' && (
        <>
          {content.pages.contact.body && <Paragraphs text={content.pages.contact.body} />}
          {contactDetails && (
            <dl className="grid gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-5 ring-1 ring-black/5 @2xl:grid-cols-2">
              {contact.phone && <div><dt className="text-sm opacity-70">{t('contactPhone')}</dt><dd><a className="underline" href={`tel:${contact.phone.replace(/[^+0-9]/g, '')}`}>{contact.phone}</a></dd></div>}
              {contact.email && <div><dt className="text-sm opacity-70">{t('contactEmail')}</dt><dd><a className="break-all underline" href={`mailto:${contact.email}`}>{contact.email}</a></dd></div>}
              {contact.address && <div><dt className="text-sm opacity-70">{t('contactAddress')}</dt><dd className="whitespace-pre-line">{contact.address}</dd></div>}
              {contact.hours && <div><dt className="text-sm opacity-70">{t('contactHours')}</dt><dd>{contact.hours}</dd></div>}
            </dl>
          )}
        </>
      )}
      {slug === 'faq' && <FaqList items={content.pages.faq.items} />}
      {(slug === 'shipping' || slug === 'refund' || slug === 'privacy' || slug === 'terms') && (
        <>
          {policyParagraphs(slug, facts, shopName, t, locale).map((p, i) => <p key={i}>{p}</p>)}
          {content.policies[slug] && <Paragraphs text={content.policies[slug]!} />}
          {(facts.legalName || facts.address) && (
            <p className="text-sm opacity-70">
              {facts.legalName && <>{t('policy.seller', { name: facts.legalName })}<br /></>}
              {facts.address && <span className="whitespace-pre-line">{t('policy.address', { address: facts.address })}</span>}
            </p>
          )}
        </>
      )}
    </article>
  );
}
