import { handleGoogleCallback, handleGoogleMfa } from '@/lib/auth/google-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handleGoogleCallback;
export const POST = handleGoogleMfa;
