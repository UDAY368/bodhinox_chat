import type { ProductReviews } from '@/lib/commerce/review-data';

/** Five stars filled to `value` (0 to 5); the text label is for screen readers. */
export function Stars({ value, label }: { value: number; label: string }) {
  return (
    <span role="img" aria-label={label} className="relative inline-block whitespace-nowrap leading-none">
      <span aria-hidden className="opacity-25">★★★★★</span>
      <span aria-hidden className="absolute inset-y-0 left-0 overflow-hidden whitespace-nowrap text-[var(--shop-primary)]"
        style={{ width: `${Math.max(0, Math.min(5, value)) * 20}%` }}>★★★★★</span>
    </span>
  );
}

export interface ReviewLabels {
  title: string;
  /** "4.5 out of 5" */
  average: string;
  /** "12 reviews" */
  count: string;
  customer: string;
  /** (rating) => "4 out of 5 stars" */
  stars: (rating: number) => string;
}

/** The product page's reviews: average and count, then the latest published ones. Shows nothing when there are none. */
export function ProductReviewsSection({ reviews, locale, labels }: { reviews: ProductReviews; locale: string; labels: ReviewLabels }) {
  if (!reviews.summary) return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  return (
    <section id="reviews" aria-labelledby="reviews-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="reviews-title" className="text-xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{labels.title}</h2>
        <p className="flex items-center gap-2 text-sm">
          <Stars value={reviews.summary.average} label={labels.average} />
          <span>{labels.average} · {labels.count}</span>
        </p>
      </div>
      <ul className="grid gap-3 @3xl:grid-cols-2">
        {reviews.latest.map((r, i) => (
          <li key={i} className="flex flex-col gap-1 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 shadow-sm ring-1 ring-black/5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <Stars value={r.rating} label={labels.stars(r.rating)} />
              <span className="text-xs opacity-60">{date.format(new Date(r.date))}</span>
            </div>
            {r.body && <p className="whitespace-pre-line break-words text-sm">{r.body}</p>}
            <p className="text-xs opacity-70">{r.reviewer ?? labels.customer}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
