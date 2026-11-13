'use client';

// Appointments (Phase 7): the schedule, the appointment sheet (?id=<id>, which
// staff notifications link to) and the configuration tabs (?tab=). Every
// member can read; agents and above book and change appointments
// (appointments.manage); admins and above configure (appointments.settings).
// The server enforces roles, permissions and the plan; the UI only hides what
// a role can never do.

import { Suspense, useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { AppointmentSheet } from '@/components/appointments/appointment-sheet';
import { BookingPagesPanel } from '@/components/appointments/booking-pages-panel';
import { ExceptionsPanel } from '@/components/appointments/exceptions-panel';
import { LocationsPanel } from '@/components/appointments/locations-panel';
import { NewAppointmentDialog } from '@/components/appointments/new-appointment-dialog';
import { ScheduleView } from '@/components/appointments/schedule-view';
import { ServicesPanel } from '@/components/appointments/services-panel';
import { SettingsPanel } from '@/components/appointments/settings-panel';
import { StaffPanel } from '@/components/appointments/staff-panel';
import { TasksPanel } from '@/components/appointments/tasks-panel';
import { abilitiesFor, useAppointmentConfig } from '@/components/appointments/shared';
import { useAuth } from '@/hooks/use-auth';

const APPOINTMENT_TABS = ['schedule', 'tasks', 'services', 'staff', 'locations', 'exceptions', 'pages', 'settings'] as const;
type Tab = (typeof APPOINTMENT_TABS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <AppointmentsContent />
    </Suspense>
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

  const rawTab = params.get('tab');
  const tab: Tab = (APPOINTMENT_TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'schedule';
  const rawId = params.get('id');
  const openId = rawId && UUID.test(rawId) ? rawId : null;

  const navigate = useCallback((next: { tab?: Tab; id?: string | null }) => {
    const q = new URLSearchParams(params.toString());
    if (next.tab) q.set('tab', next.tab);
    if (next.id === null) q.delete('id');
    else if (next.id) q.set('id', next.id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const changed = useCallback(() => setRefreshKey((k) => k + 1), []);
  const configChanged = useCallback(() => {
    void reload();
    changed();
  }, [reload, changed]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {config.state === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
      {config.state === 'failed' && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {t('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
        </div>
      )}
      {config.state === 'unavailable' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          {t('upgrade')} <UpgradeBadge />
        </div>
      )}

      {config.state === 'ready' && (
        <>
          {!abilities.manage && <p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
          <Tabs value={tab} onValueChange={(v) => navigate({ tab: v as Tab })}>
            <TabsList className="max-w-full justify-start overflow-x-auto bg-muted [scrollbar-width:none] *:flex-none">
              {APPOINTMENT_TABS.map((key) => <TabsTrigger key={key} value={key}>{t(`tabs.${key}`)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="schedule" className="pt-4">
              <ScheduleView config={config.config} abilities={abilities} refreshKey={refreshKey}
                onOpen={(id) => navigate({ id })} onNew={() => { setPreferred(null); setCreating(true); }}
                onSlot={(date, time) => { setPreferred({ date, time }); setCreating(true); }}
                onOpenTab={(next) => navigate({ tab: next })} />
            </TabsContent>
            <TabsContent value="tasks" className="pt-4">
              <TasksPanel canManage={abilities.manage} onOpenAppointment={(id) => navigate({ id })} />
            </TabsContent>
            <TabsContent value="services" className="pt-4">
              <ServicesPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
            </TabsContent>
            <TabsContent value="staff" className="pt-4">
              <StaffPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
            </TabsContent>
            <TabsContent value="locations" className="pt-4">
              <LocationsPanel config={config.config} canEdit={abilities.settings} onChanged={configChanged} />
            </TabsContent>
            <TabsContent value="exceptions" className="pt-4">
              <ExceptionsPanel config={config.config} canEdit={abilities.settings} />
            </TabsContent>
            <TabsContent value="pages" className="pt-4">
              <BookingPagesPanel config={config.config} canEdit={abilities.settings} />
            </TabsContent>
            <TabsContent value="settings" className="pt-4">
              <SettingsPanel canEdit={abilities.settings} />
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
