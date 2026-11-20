'use client';

// Appointments: one screen with four tabs (?tab=) — Schedule (Today / Week / List in ?view=, with what needs
// attention and the follow-up tasks), Services, Team (staff and hours, holidays, locations) and Settings
// (booking pages, messages and reminders, deals). The booking sheet opens from ?id=<id> (staff
// notifications, payments and contact cards link there). Old ?tab= values (tasks, staff, locations,
// exceptions, pages) are replaced by their new tab and scrolled to their section.
// Every member can read; agents and above book and change appointments (appointments.manage); admins and
// above configure (appointments.settings). The server enforces roles, permissions and the plan; the UI
// only hides what a role can never do.

import { Suspense, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Clock, Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { AppointmentSheet } from '@/components/appointments/appointment-sheet';
import { BookingPagesPanel } from '@/components/appointments/booking-pages-panel';
import { ExceptionsPanel } from '@/components/appointments/exceptions-panel';
import { LocationsPanel } from '@/components/appointments/locations-panel';
import { NewAppointmentDialog } from '@/components/appointments/new-appointment-dialog';
import { ReminderTemplateCard } from '@/components/appointments/reminder-template-card';
import { ScheduleView } from '@/components/appointments/schedule-view';
import { ServicesPanel } from '@/components/appointments/services-panel';
import { DealStageCard, SettingsPanel } from '@/components/appointments/settings-panel';
import { StaffPanel } from '@/components/appointments/staff-panel';
import { TasksPanel } from '@/components/appointments/tasks-panel';
import {
  abilitiesFor, APPOINTMENT_SCREEN_TABS, parseView, resolveTab, useAppointmentConfig,
  type AppointmentScreenTab, type ScheduleViewName,
} from '@/components/appointments/shared';
import { useAuth } from '@/hooks/use-auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <AppointmentsContent />
    </Suspense>
  );
}

/** A scroll target for old ?tab= links. The title is left out where the panel inside has its own heading. */
function Section({ id, title, children }: { id: string; title?: string; children: React.ReactNode }) {
  return (
    <section id={`appt-section-${id}`} className="scroll-mt-20 space-y-3">
      {title && <h2 className="text-title-3 font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function AppointmentsContent() {
  const t = useTranslations('Appointments');
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { accountRole } = useAuth();
  const abilities = abilitiesFor(accountRole);
  const { config, reload } = useAppointmentConfig();
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  // A day and time clicked on the week calendar, offered first in the booking dialog.
  const [preferred, setPreferred] = useState<{ date: string; time: string } | null>(null);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the default view depends on the screen, known only in the browser
    setPhone(window.matchMedia('(max-width: 699px)').matches);
  }, []);

  const resolved = resolveTab(params.get('tab'));
  const tab = resolved.tab;
  const view = parseView(params.get('view'), phone);
  const rawId = params.get('id');
  const openId = rawId && UUID.test(rawId) ? rawId : null;

  const navigate = useCallback((next: { tab?: AppointmentScreenTab; id?: string | null; view?: ScheduleViewName }) => {
    const q = new URLSearchParams(params.toString());
    if (next.tab) q.set('tab', next.tab);
    if (next.view) q.set('view', next.view);
    if (next.id === null) q.delete('id');
    else if (next.id) q.set('id', next.id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  // An old ?tab= link: replace it with the new tab, then show the section it meant.
  const legacySection = resolved.legacy ? resolved.section : null;
  useEffect(() => {
    if (!resolved.legacy) return;
    navigate({ tab: resolved.tab });
    if (legacySection) {
      const timer = setTimeout(() => document.getElementById(`appt-section-${legacySection}`)?.scrollIntoView({ block: 'start' }), 300);
      return () => clearTimeout(timer);
    }
  }, [resolved.legacy, resolved.tab, legacySection, navigate]);

  const changed = useCallback(() => setRefreshKey((k) => k + 1), []);
  const configChanged = useCallback(() => {
    void reload();
    changed();
  }, [reload, changed]);
  const newBooking = () => { setPreferred(null); setCreating(true); };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        primaryAction={config.state === 'ready' && abilities.manage
          ? <Button type="button" onClick={newBooking}>{t('screen.newBooking')}</Button>
          : undefined}
        moreActions={config.state === 'ready' ? [
          { label: t('screen.bookingLink'), icon: Link2, onSelect: () => navigate({ tab: 'settings' }) },
          { label: t('tabs.services'), icon: Clock, onSelect: () => navigate({ tab: 'services' }) },
        ] : undefined}
      />

      {config.state === 'loading' && <PageLoading />}
      {config.state === 'failed' && <InlineError message={t('loadFailed')} onRetry={() => void reload()} />}
      {config.state === 'unavailable' && (
        <div className="flex flex-wrap items-center gap-2 rounded-group border border-separator bg-grouped-surface p-6 text-sm text-muted-foreground">
          {t('upgrade')} <UpgradeBadge />
        </div>
      )}

      {config.state === 'ready' && (
        <>
          {!abilities.manage && <p className="text-footnote text-muted-foreground">{t('readOnly')}</p>}
          <Tabs value={tab} onValueChange={(v) => navigate({ tab: v as AppointmentScreenTab })}>
            <TabsList className="max-w-full justify-start overflow-x-auto bg-muted [scrollbar-width:none] *:flex-none">
              {APPOINTMENT_SCREEN_TABS.map((key) => <TabsTrigger key={key} value={key}>{t(`tabs.${key}`)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="schedule" className="space-y-8 pt-4">
              <ScheduleView config={config.config} abilities={abilities} refreshKey={refreshKey}
                view={view} onViewChange={(v) => navigate({ view: v })} onChanged={changed}
                onOpen={(id) => navigate({ id })} onNew={newBooking}
                onSlot={(date, time) => { setPreferred({ date, time }); setCreating(true); }} />
              <Section id="attention" title={t('screen.attention')}>
                <TasksPanel canManage={abilities.manage} onOpenAppointment={(id) => navigate({ id })} />
              </Section>
            </TabsContent>
            <TabsContent value="services" className="pt-4">
              <ServicesPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
            </TabsContent>
            <TabsContent value="team" className="space-y-8 pt-4">
              <Section id="staff">
                <StaffPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
              </Section>
              <Section id="exceptions">
                <ExceptionsPanel config={config.config} canEdit={abilities.settings} />
              </Section>
              <Section id="locations">
                <LocationsPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
              </Section>
            </TabsContent>
            <TabsContent value="settings" className="space-y-8 pt-4">
              <Section id="pages">
                <BookingPagesPanel config={config.config} canEdit={abilities.settings} />
              </Section>
              <Section id="messages" title={t('screen.settingsMessages')}>
                <SettingsPanel canEdit={abilities.settings} />
                <ReminderTemplateCard canEdit={abilities.settings} />
              </Section>
              <Section id="deals" title={t('screen.settingsDeals')}>
                <DealStageCard canEdit={abilities.settings} />
              </Section>
            </TabsContent>
          </Tabs>

          <AppointmentSheet id={openId} config={config.config} abilities={abilities}
            onClose={() => navigate({ id: null })} onChanged={changed} />
          {abilities.manage && (
            <NewAppointmentDialog open={creating} onOpenChange={setCreating} config={config.config} preferred={preferred}
              onBooked={(id) => { changed(); navigate({ id }); }} />
          )}
        </>
      )}
    </div>
  );
}
