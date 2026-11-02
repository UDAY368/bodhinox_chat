import { handleGoogleStatus, handleGoogleUnlink } from '@/lib/auth/google-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handleGoogleStatus;
export const DELETE = handleGoogleUnlink;
