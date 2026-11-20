import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/settings/numbers/use-whatsapp-numbers', () => ({ useWhatsAppNumbers: () => ({ numbers: [] }) }));

import { pageLinks } from './booking-pages-panel';
import type { AppointmentConfig } from './shared';

const svc = (id: string, name: string, archived = false) => ({ id, name, archived_at: archived ? '2026-01-01' : null }) as unknown as AppointmentConfig['services'][number];
const staff = (id: string, name: string, archived = false) => ({ id, display_name: name, user_id: null, archived_at: archived ? '2026-01-01' : null }) as AppointmentConfig['staff'][number];

const config: AppointmentConfig = {
  services: [svc('s1', 'Haircut'), svc('s2', 'Colour'), svc('s3', 'Old', true), svc('s4', 'Not on page')],
  staff: [staff('t1', 'Asha'), staff('t2', 'Ravi'), staff('t3', 'Gone', true), staff('t4', 'Elsewhere')],
  locations: [],
  offerings: [
    { id: 'o1', service_id: 's1', staff_id: 't1', location_id: 'L1' },
    { id: 'o2', service_id: 's2', staff_id: 't1', location_id: 'L1' },
    { id: 'o3', service_id: 's2', staff_id: 't2', location_id: 'L2' },
    { id: 'o4', service_id: 's1', staff_id: 't3', location_id: 'L1' },
    { id: 'o5', service_id: 's4', staff_id: 't4', location_id: 'L1' },
    { id: 'o6', service_id: 's1', staff_id: null, location_id: 'L1' },
  ],
};

describe('pageLinks', () => {
  const page = { slug: 'salon', service_ids: ['s1', 's2', 's3'], location_id: null };

  it('lists the page, its live services and the live practitioners who offer them', () => {
    expect(pageLinks('https://app.test/', page, config)).toEqual([
      { kind: 'page', id: 'salon', label: 'salon', url: 'https://app.test/book/salon' },
      { kind: 'service', id: 's1', label: 'Haircut', url: 'https://app.test/book/salon?service=s1' },
      { kind: 'service', id: 's2', label: 'Colour', url: 'https://app.test/book/salon?service=s2' },
      { kind: 'staff', id: 't1', label: 'Asha', url: 'https://app.test/book/salon?staff=t1' },
      { kind: 'staff', id: 't2', label: 'Ravi', url: 'https://app.test/book/salon?staff=t2' },
    ]);
  });

  it('keeps only practitioners at the page’s own place', () => {
    const links = pageLinks('https://app.test', { ...page, location_id: 'L1' }, config);
    expect(links.filter((l) => l.kind === 'staff').map((l) => l.id)).toEqual(['t1']);
  });
});
