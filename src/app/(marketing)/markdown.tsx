// A small, safe Markdown renderer for the static help and legal pages: headings
// (with anchors), paragraphs, ordered and unordered lists, tables, blockquotes,
// **bold**, *italic*, `code` and links. It builds React elements only (never raw
// HTML), and a link renders as a link only for http(s), mailto, same-site paths
// and in-page anchors; anything else (repository-relative paths) stays plain text.

import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT_ROOT = join(process.cwd(), 'content');
const NAME = /^[a-z0-9-]+$/;

/** Reads content/<folder>/<name>.md (names are fixed constants, checked anyway). */
export function readContent(folder: 'help' | 'legal', name: string): string {
  if (!NAME.test(name)) throw new Error('Invalid content name');
  return readFileSync(join(CONTENT_ROOT, folder, `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

export function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (token.startsWith('**')) out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith('`')) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      const label = link ? renderInline(link[1], key) : token;
      out.push(
        href ? (
          <a key={key} href={href} className="text-primary underline underline-offset-2" {...(/^https?:/i.test(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Renders a Markdown document. Level-1 headings get `idPrefix`-free slugs; others are prefixed. */
export function Markdown({ source, idPrefix = '' }: { source: string; idPrefix?: string }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = `${idPrefix}${slugify(text)}`;
      const className = ['', 'text-2xl font-semibold tracking-tight', 'mt-8 text-xl font-semibold', 'mt-6 text-lg font-semibold', 'mt-4 font-semibold'][level];
      const content = renderInline(text, key());
      if (level === 1) blocks.push(<h2 key={key()} id={id} className={className}>{content}</h2>);
      else if (level === 2) blocks.push(<h3 key={key()} id={id} className={className}>{content}</h3>);
      else blocks.push(<h4 key={key()} id={id} className={className}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const tk = key();
      blocks.push(
        <div key={tk} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>{header.map((c, j) => <th key={j} className="border-b border-border px-2 py-1.5 text-left font-semibold">{renderInline(c, `${tk}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>{row.map((c, j) => <td key={j} className="border-b border-border px-2 py-1.5 align-top">{renderInline(c, `${tk}r${r}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ''));
        else if (items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const lk = key();
      const children = items.map((item, j) => <li key={j}>{renderInline(item, `${lk}-${j}`)}</li>);
      blocks.push(ordered
        ? <ol key={lk} className="list-decimal space-y-1.5 pl-6">{children}</ol>
        : <ul key={lk} className="list-disc space-y-1.5 pl-6">{children}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quoted.push(lines[i++].replace(/^>\s?/, ''));
      const qk = key();
      blocks.push(<blockquote key={qk} className="border-l-2 border-border pl-4 text-muted-foreground">{renderInline(quoted.join(' '), qk)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*\||>)/.test(lines[i])) paragraph.push(lines[i++].trim());
    if (!paragraph.length) {
      // A line no block accepted (e.g. a lone table row): show it as text.
      paragraph.push(lines[i++].trim());
    }
    const pk = key();
    blocks.push(<p key={pk} className="leading-relaxed">{renderInline(paragraph.join(' '), pk)}</p>);
  }
  return <div className="space-y-4 text-[15px] text-foreground">{blocks}</div>;
}
