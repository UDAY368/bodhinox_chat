import type { AccountRole } from '@/lib/auth/roles';
export interface MediaContext { accountId: string; userId?: string; role?: AccountRole }
const buckets = new Set(['chat-media', 'flow-media', 'avatars']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function authorizeObject(bucket: string, path: string, context: MediaContext, mode: 'read' | 'write'): void {
  if (!buckets.has(bucket) || !uuid.test(context.accountId)) throw new Error('Invalid media resource');
  if (!path || path.length > 1024 || path.includes('%') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f]/.test(path)) throw new Error('Invalid object path');
  if (bucket === 'avatars') {
    const owner = path.split('/')[0];
    if (!uuid.test(owner) || (mode === 'write' && owner !== context.userId)) throw new Error('Avatar access denied');
  } else if (!path.startsWith(`account-${context.accountId}/`)) throw new Error('Media belongs to another workspace');
  if (mode === 'write' && bucket !== 'avatars' && context.role === 'viewer') throw new Error('Viewer cannot upload media');
}
export function storageKey(bucket: string, path: string, context: MediaContext): string {
  authorizeObject(bucket, path, context, 'read');
  return `${context.accountId}/${bucket}/${path}`;
}
export function validateUpload(bucket: string, contentType: string, size: number): void {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const media = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp4|ogg|wav|webm|aac|opus)|video\/(mp4|webm|3gpp)|application\/(pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|msword|vnd\.ms-excel|vnd\.ms-powerpoint)|text\/plain)$/;
  const avatar = /^image\/(png|jpeg|webp|gif)$/;
  if (!buckets.has(bucket) || !(bucket === 'avatars' ? avatar : media).test(type)) throw new Error('Unsupported media type');
  const ceiling = bucket === 'avatars' || type.startsWith('image/') ? 5 * 1024 * 1024 : 16 * 1024 * 1024;
  if (!Number.isSafeInteger(size) || size <= 0 || size > ceiling) throw new Error('Media exceeds the permitted size');
}
