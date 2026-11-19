/** The fixed caps and field types of the checkout extras. No imports, so the settings page can use them in the browser. */
export const EXTRAS_LIMITS = {
  note: 300, giftMessage: 200, slots: 6, slotLabel: 40, customFields: 5, fieldLabel: 60, options: 10, option: 40, textValue: 200,
  leadDays: 60, windowDays: 60,
} as const;

export const CUSTOM_FIELD_TYPES = ['text', 'select', 'checkbox'] as const;
