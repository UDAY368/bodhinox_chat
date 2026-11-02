import type { TemplateKind } from '@/types';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';

/**
 * What the template studio dialogs hand back to the editor: a partial
 * template the user finishes and submits. Only name, category and
 * language are guaranteed; everything else is filled in as known.
 */
export type TemplateDraftInput = Partial<TemplatePayload> & {
  name: string;
  category: TemplatePayload['category'];
  language: string;
  template_kind?: TemplateKind;
};
