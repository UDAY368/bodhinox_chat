import { cn } from '@/lib/utils';
import styles from './khaga-icon.module.css';

/** Decorative KHAGA mark. Keep activity text alongside it for screen readers. */
export function KhagaIcon({
  className,
  activity = 'idle',
}: {
  className?: string;
  activity?: 'idle' | 'searching' | 'thinking' | 'typing';
}) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false"
      data-khaga-activity={activity}
      className={cn('h-6 w-6 shrink-0', styles.icon, styles[activity], className)}>
      <g fill="#F28A24" className={styles.petals}>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
          <path key={angle} transform={`rotate(${angle} 24 24)`}
            d="M24 1C21 4.5 19.8 7 24 10.5C28.2 7 27 4.5 24 1Z" />
        ))}
      </g>
      <circle cx="24" cy="24" r="14.5" fill="#FFFAED" stroke="#D96820" strokeWidth="1.25" />
      <rect x="12.5" y="12.5" width="23" height="23" rx="11" fill="#22221F" />
      <g fill="#FFFAED" className={styles.eyes}>
        <rect x="18" y="19" width="3.5" height="10" rx="1.75" />
        <rect x="26.5" y="19" width="3.5" height="10" rx="1.75" />
      </g>
    </svg>
  );
}
