import { handleAuthGet, handleAuthPost } from '@/lib/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) {
  return handleAuthGet(request, (await context.params).action);
}
export async function POST(request: Request, context: Context) {
  return handleAuthPost(request, (await context.params).action);
}
