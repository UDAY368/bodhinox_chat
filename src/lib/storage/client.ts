import { authFetch } from '@/lib/auth/client';

export function mediaObjectUrl(bucket: string, path: string): string {
  return `/api/media/object?${new URLSearchParams({ bucket, key: path })}`;
}
export function createStorageFacade() {
  return {
    from(bucket: string) {
      return {
        async upload(path: string, body: File | Blob | Uint8Array, options: { contentType?: string; cacheControl?: string; upsert?: boolean } = {}) {
          try {
            const form = new FormData();
            form.set('bucket', bucket); form.set('key', path); form.set('upsert', String(!!options.upsert));
            const file = body instanceof Blob ? body : new Blob([Uint8Array.from(body)], { type: options.contentType });
            form.set('file', file);
            const response = await authFetch('/api/media/object', { method: 'POST', body: form });
            const result = await response.json();
            return response.ok ? { data: { path }, error: null } : { data: null, error: { message: result.error?.message ?? result.error ?? 'Upload failed' } };
          } catch { return { data: null, error: { message: 'Unable to upload media' } }; }
        },
        getPublicUrl(path: string) { return { data: { publicUrl: mediaObjectUrl(bucket, path) } }; },
        async remove(paths: string[]) {
          try {
            const response = await authFetch('/api/media/object', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket, paths }) });
            const result = await response.json();
            return { error: response.ok ? null : { message: result.error?.message ?? result.error ?? 'Delete failed' } };
          } catch { return { error: { message: 'Unable to delete media' } }; }
        },
      };
    },
  };
}
