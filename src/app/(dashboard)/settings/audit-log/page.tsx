import { redirect } from 'next/navigation';

// The audit log has one home: the Audit log tab of Settings. Old links land there.
export default function AuditLogPage() {
  redirect('/settings?tab=audit-log');
}
