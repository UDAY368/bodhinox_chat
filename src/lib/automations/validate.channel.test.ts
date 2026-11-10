import { describe, expect, it } from 'vitest';
import { AUTOMATION_STEPS_BY_CHANNEL, AUTOMATION_TRIGGERS_BY_CHANNEL } from '@/lib/channels/capabilities';
import {
  automationChannel,
  channelPaletteIssues,
  parseAutomationChannel,
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';
import { AUTOMATION_TEMPLATES, getTemplate, templateOnChannel } from './templates';

// Stage 1: an automation belongs to one channel and may use only its palette.

const buttons = (n: number, title = 'Option') => ({
  kind: 'buttons',
  body: 'Pick one',
  buttons: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `${title} ${i}` })),
});

describe('channel palettes', () => {
  it('leaves WhatsApp with every trigger and step', () => {
    for (const trigger of AUTOMATION_TRIGGERS_BY_CHANNEL.whatsapp)
      expect(channelPaletteIssues('whatsapp', trigger, [])).toEqual([]);
    const steps = AUTOMATION_STEPS_BY_CHANNEL.whatsapp.map((step_type) => ({ step_type, step_config: {} }));
    expect(channelPaletteIssues('whatsapp', 'new_message_received', steps)).toEqual([]);
  });

  it('refuses Instagram triggers it does not offer', () => {
    for (const trigger of ['time_based', 'ad_click', 'appointment_booked', 'appointment_no_show'])
      expect(channelPaletteIssues('instagram', trigger, []).map((i) => i.path)).toEqual(['trigger.type']);
    for (const trigger of AUTOMATION_TRIGGERS_BY_CHANNEL.instagram)
      expect(channelPaletteIssues('instagram', trigger, [])).toEqual([]);
  });

  it('refuses template and list steps on Instagram, nested branches included', () => {
    const issues = channelPaletteIssues('instagram', 'new_message_received', [
      { step_type: 'send_template', step_config: {} },
      { step_type: 'condition', step_config: {}, branches: { yes: [{ step_type: 'send_list', step_config: {} }], no: [] } },
      { step_type: 'add_tag', step_config: {} },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0]', 'steps[1].yes.steps[0]']);
    expect(issues[0].message).toContain('Instagram');
  });

  it('leaves an unknown type to the other checks', () => {
    expect(channelPaletteIssues('instagram', 'some_future_trigger', [{ step_type: 'some_future_step', step_config: {} }])).toEqual([]);
  });

  it('lets an Instagram draft keep an unfinished reply-button step', () => {
    expect(channelPaletteIssues('instagram', 'new_message_received', [{ step_type: 'send_buttons', step_config: {} }])).toEqual([]);
  });
});

describe('activation on a channel', () => {
  it('refuses an Instagram trigger outside the palette and keeps the WhatsApp default', () => {
    expect(validateTriggerForActivation('time_based', { schedule: '0 9 * * *' }, [], 'instagram').map((i) => i.path))
      .toContain('trigger.type');
    expect(validateTriggerForActivation('time_based', { schedule: '0 9 * * *' })).toEqual([]);
  });

  it('needs Instagram reply buttons that fit quick replies', () => {
    const step = (config: Record<string, unknown>) => [{ step_type: 'send_buttons', step_config: config }];
    expect(validateStepsForActivation(step(buttons(3)), 'instagram')).toEqual([]);
    expect(validateStepsForActivation(step(buttons(3)), 'whatsapp')).toEqual([]);
    const list = { kind: 'list', body: 'Pick', button_label: 'Open', sections: [{ rows: [{ id: 'a', title: 'A' }] }] };
    expect(validateStepsForActivation(step(list), 'instagram').map((i) => i.path)).toContain('steps[0].interactive');
    const longTitle = buttons(1, 'A title much longer than Instagram allows');
    expect(validateStepsForActivation(step(longTitle), 'instagram').map((i) => i.path)).toContain('steps[0].interactive');
  });

  it('refuses a template step on Instagram at activation too', () => {
    expect(validateStepsForActivation([{ step_type: 'send_template', step_config: { template_name: 't' } }], 'instagram')
      .map((i) => i.path)).toEqual(['steps[0]']);
  });
});

describe('channel values', () => {
  it('reads a request: absent is WhatsApp, anything else must be a channel', () => {
    expect(parseAutomationChannel(undefined)).toBe('whatsapp');
    expect(parseAutomationChannel(null)).toBe('whatsapp');
    expect(parseAutomationChannel('instagram')).toBe('instagram');
    for (const bad of ['any', 'sms', '', 1, {}]) expect(parseAutomationChannel(bad)).toBeNull();
  });

  it('reads a row: anything but instagram is WhatsApp', () => {
    expect(automationChannel({ channel: 'instagram' })).toBe('instagram');
    expect(automationChannel({})).toBe('whatsapp');
    expect(automationChannel(null)).toBe('whatsapp');
  });
});

describe('starter templates per channel', () => {
  it('fit every channel they are offered in', () => {
    for (const template of Object.values(AUTOMATION_TEMPLATES)) {
      expect(template.channels.length).toBeGreaterThan(0);
      for (const channel of template.channels)
        expect(channelPaletteIssues(channel, template.trigger_type, template.steps)).toEqual([]);
    }
  });

  it('keep the day-later follow-up off Instagram (its reply window has closed)', () => {
    expect(templateOnChannel(AUTOMATION_TEMPLATES.follow_up_reminder, 'instagram')).toBe(false);
    expect(templateOnChannel(AUTOMATION_TEMPLATES.welcome_message, 'instagram')).toBe(true);
  });

  it('look up only real slugs', () => {
    expect(getTemplate('welcome_message')?.slug).toBe('welcome_message');
    expect(getTemplate('toString')).toBeNull();
    expect(getTemplate('nope')).toBeNull();
  });
});
