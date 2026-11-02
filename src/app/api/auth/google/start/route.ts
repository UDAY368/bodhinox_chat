import { handleGoogleLinkStart, handleGoogleSignInStart } from '@/lib/auth/google-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handleGoogleSignInStart;
export const POST = handleGoogleLinkStart;
