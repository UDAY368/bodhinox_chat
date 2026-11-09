// 404 for unmatched URLs and notFound() calls without a nearer not-found file: a translated
// message inside the root layout (theme and fonts apply) with a way back.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SearchX } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function NotFound() {
  const t = await getTranslations('ErrorPages');
  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <SearchX className="text-primary h-6 w-6" />
          </div>
          <CardTitle className="text-foreground text-xl">{t('notFoundTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('notFoundDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/dashboard" className={buttonVariants({ className: 'w-full' })}>
            {t('goHome')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
