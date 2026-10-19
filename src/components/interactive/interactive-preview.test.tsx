import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractivePreview } from './interactive-preview';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

describe('enhanced interactive preview', () => {
  it('hides the preceding location when the inbox renders its own attachment row', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'buttons',
      body: 'Visit us',
      media: {
        type: 'location',
        latitude: 12.9,
        longitude: 77.6,
        name: 'Our office',
      },
      buttons: [{ id: 'ok', title: 'Directions' }],
    };
    const html = renderToStaticMarkup(
      <InteractivePreview payload={payload} showPrelude={false} />
    );
    expect(html).not.toContain('Our office');
    expect(html).not.toContain('12.9, 77.6');
    expect(html).toContain('Visit us');
    expect(html).toContain('Directions');
  });

  it('hides a preceding list attachment without hiding its body or text header', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'list',
      body: 'Select a service',
      header: 'Services',
      media: {
        type: 'document',
        url: '/api/storage/object?key=guide',
        filename: 'Services.pdf',
      },
      button_label: 'Browse',
      sections: [{ rows: [{ id: 'a', title: 'Service A' }] }],
    };
    const html = renderToStaticMarkup(
      <InteractivePreview payload={payload} showPrelude={false} />
    );
    expect(html).not.toContain('Services.pdf');
    expect(html).toContain('Select a service');
    expect(html).toContain('Services</p>');
    expect(html).toContain('Browse');
  });

  it('retains native media headers when preceding attachments are hidden', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'buttons',
      body: 'View this',
      media: { type: 'image', url: '/api/storage/object?key=photo' },
      buttons: [{ id: 'ok', title: 'OK' }],
    };
    const html = renderToStaticMarkup(
      <InteractivePreview payload={payload} showPrelude={false} />
    );
    expect(html).toContain('src="/api/storage/object?key=photo"');
    expect(html).toContain('View this');
  });

  it('renders a location attachment before the reply message', () => {
    const payload = {
      kind: 'buttons',
      body: 'Visit us',
      media: {
        type: 'location',
        latitude: 12.9,
        longitude: 77.6,
        name: 'Our office',
        address: 'Main Street',
      },
      buttons: [{ id: 'ok', title: 'Directions' }],
    } as InteractiveMessagePayload;
    const html = renderToStaticMarkup(<InteractivePreview payload={payload} />);
    expect(html).toContain('Our office');
    expect(html).toContain('12.9, 77.6');
    expect(html.indexOf('Our office')).toBeLessThan(html.indexOf('Visit us'));
  });

  it('shows attached documents and distinguishes a link action from reply buttons', () => {
    const payload = {
      kind: 'buttons',
      body: 'Download',
      media: {
        type: 'document',
        url: '/api/storage/object?key=guide',
        filename: 'Guide.pdf',
      },
      buttons: [
        {
          id: 'site',
          title: 'Website',
          action: { type: 'url', url: 'https://example.com' },
        },
      ],
    } as InteractiveMessagePayload;
    const html = renderToStaticMarkup(<InteractivePreview payload={payload} />);
    expect(html).toContain('Guide.pdf');
    expect(html).toContain('Open link');
    expect(html).not.toContain('lucide-reply');
  });

  it('keeps media before a list and preserves the list text header', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'list',
      body: 'Select a service',
      header: 'Services',
      media: {
        type: 'document',
        url: '/api/storage/object?key=guide',
        filename: 'Services.pdf',
      },
      button_label: 'Browse',
      sections: [{ rows: [{ id: 'a', title: 'Service A' }] }],
    };
    const html = renderToStaticMarkup(<InteractivePreview payload={payload} />);
    expect(html.indexOf('Services.pdf')).toBeLessThan(
      html.indexOf('Select a service')
    );
    expect(html).toContain('Services</p>');
    expect(html).toContain('Browse');
  });

  it('shows a media header without implying two native headers and resolves workflow names', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'buttons',
      body: 'Choose',
      header: 'Incompatible text header',
      media: { type: 'image', url: '/api/storage/object?key=photo' },
      buttons: [
        {
          id: 'a',
          title: 'Start',
          action: { type: 'automation', targetId: 'target-1' },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <InteractivePreview
        payload={payload}
        targetNames={{ 'automation:target-1': 'Welcome sequence' }}
      />
    );
    expect(html).toContain('Welcome sequence');
    expect(html).toContain('src="/api/storage/object?key=photo"');
    expect(html).not.toContain('Incompatible text header');
  });
});
