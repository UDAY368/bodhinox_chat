import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import {
  authorizeObject,
  storageKey,
  validateUpload,
  type MediaContext,
} from './policy';
import { mediaObjectUrl } from './client';
import { releaseStorage, reserveStorage } from '@/lib/billing/limits';

let client: S3Client | undefined;
function s3() {
  for (const name of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ])
    if (!process.env[name])
      throw new Error(`Missing required configuration: ${name}`);
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}
export async function putMedia(
  context: MediaContext,
  bucket: string,
  path: string,
  body: Uint8Array,
  contentType: string,
  upsert = false,
  worker = false
) {
  authorizeObject(bucket, path, context, 'write');
  validateUpload(bucket, contentType, body.byteLength);
  // The bytes are checked and recorded in one locked transaction before the
  // put, so concurrent uploads cannot each pass on the same total. A member's
  // upload must fit the plan's storage; media the system stores for customers
  // (inbound messages, worker) is never refused.
  const db = worker ? getWorkerPrisma() : undefined;
  const reservation = await withTenant(
    context,
    (tx) =>
      reserveStorage(tx, {
        accountId: context.accountId,
        uploadedBy: context.userId ?? null,
        bucket,
        objectKey: path,
        contentType,
        bytes: body.byteLength,
        upsert,
        enforce: !worker,
      }),
    db
  );
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: storageKey(bucket, path, context),
        Body: body,
        ContentType: contentType,
        ...(upsert ? {} : { IfNoneMatch: '*' }),
      })
    );
  } catch (error) {
    await withTenant(
      context,
      (tx) => releaseStorage(tx, context.accountId, reservation),
      db
    ).catch(() => undefined);
    throw error;
  }
  await withTenant(
    context,
    (tx) =>
      tx.$executeRaw`INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size) VALUES(${context.accountId}::uuid,${context.userId ?? null}::uuid,${bucket},${path},${contentType},${body.byteLength}) ON CONFLICT(account_id,bucket,object_key) DO UPDATE SET content_type=EXCLUDED.content_type,byte_size=EXCLUDED.byte_size`,
    worker ? getWorkerPrisma() : undefined
  );
}
export async function getMedia(
  context: MediaContext,
  bucket: string,
  path: string
) {
  authorizeObject(bucket, path, context, 'read');
  const rows = await withTenant(
    context,
    (tx) =>
      tx.$queryRaw<
        { content_type: string }[]
      >`SELECT content_type FROM media_objects WHERE account_id=${context.accountId}::uuid AND bucket=${bucket} AND object_key=${path}`
  );
  if (!rows[0]) throw new Error('Media not found');
  const object = await s3().send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageKey(bucket, path, context),
    })
  );
  return { object, contentType: rows[0].content_type };
}
export async function removeMedia(
  context: MediaContext,
  bucket: string,
  path: string,
  worker = false
) {
  authorizeObject(bucket, path, context, 'write');
  await s3().send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageKey(bucket, path, context),
    })
  );
  await withTenant(
    context,
    (tx) =>
      tx.$executeRaw`DELETE FROM media_objects WHERE account_id=${context.accountId}::uuid AND bucket=${bucket} AND object_key=${path}`,
    worker ? getWorkerPrisma() : undefined
  );
}
/** Provider links are minted at dispatch time; persisted media references remain private proxy URLs. */
export async function providerMediaUrl(
  accountId: string,
  url: string
): Promise<string> {
  const origin =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'http://localhost:3000';
  const parsed = new URL(url, origin);
  if (
    parsed.origin !== new URL(origin).origin ||
    parsed.pathname !== '/api/media/object'
  )
    return url;
  const bucket = parsed.searchParams.get('bucket') || '';
  const key = parsed.searchParams.get('key') || '';
  const context = { accountId, role: 'agent' as const };
  authorizeObject(bucket, key, context, 'read');
  const found = await withTenant(
    context,
    (tx) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM media_objects WHERE account_id=${accountId}::uuid AND bucket=${bucket} AND object_key=${key}`,
    getWorkerPrisma()
  );
  if (!found.length) throw new Error('Media not found in this workspace');
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageKey(bucket, key, context),
    }),
    { expiresIn: 900 }
  );
}
export function createServerStorageFacade(
  context: MediaContext,
  worker = true
) {
  return {
    from(bucket: string) {
      return {
        async upload(
          path: string,
          body: Uint8Array | Blob | File,
          options: {
            contentType?: string;
            cacheControl?: string;
            upsert?: boolean;
          } = {}
        ) {
          try {
            const bytes =
              body instanceof Uint8Array
                ? body
                : new Uint8Array(await body.arrayBuffer());
            const contentType =
              options.contentType ??
              (body instanceof Blob ? body.type : undefined) ??
              'application/octet-stream';
            await putMedia(
              context,
              bucket,
              path,
              bytes,
              contentType,
              options.upsert,
              worker
            );
            return { data: { path }, error: null };
          } catch {
            return { data: null, error: { message: 'Media storage failed' } };
          }
        },
        getPublicUrl(path: string) {
          authorizeObject(bucket, path, context, 'read');
          return { data: { publicUrl: mediaObjectUrl(bucket, path) } };
        },
        async remove(paths: string[]) {
          try {
            if (
              !Array.isArray(paths) ||
              paths.length > 100 ||
              paths.some((path) => typeof path !== 'string')
            )
              throw new Error('Invalid object paths');
            for (const path of paths)
              authorizeObject(bucket, path, context, 'write');
            for (const path of paths)
              await removeMedia(context, bucket, path, worker);
            return { error: null };
          } catch {
            return { error: { message: 'Media removal failed' } };
          }
        },
      };
    },
  };
}
