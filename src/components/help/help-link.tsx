// The in-app "?" link to a section of the help page (/help#<section>). Opens in a
// new tab so the user keeps their place. Sections are the anchors that
// src/app/(marketing)/help renders from content/help/*.md.

import Link from 'next/link';
import { CircleHelp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

export const HELP_SECTIONS = [
  'getting-started',
  'whatsapp',
  'contacts-team',
  'flows-automations',
  'ai',
  'templates-broadcasts',
  'appointments',
  'commerce',
  'billing',
  'privacy',
] as const;

export type HelpSection = (typeof HELP_SECTIONS)[number];

export function helpHref(section: HelpSection): string {
  return `/help#${section}`;
}

export function HelpLink({ section, className }: { section: HelpSection; className?: string }) {
  const t = useTranslations('Marketing.help');
  return (
    <Link
      href={helpHref(section)}
      target="_blank"
      rel="noopener"
      aria-label={t('linkLabel')}
      title={t('linkLabel')}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <CircleHelp className="size-4" />
    </Link>
  );
}
