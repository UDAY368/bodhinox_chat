// Private object storage for report files, in the same bucket as media but
// under <account_id>/reports/<report id>.csv, outside the media buckets: report
// files are never listed in the media library, never served by the media proxy
// and do not count toward the plan's storage (they expire after 30 days).
// Only the report download route reads them, after its own checks.

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^([0-9a-f-]{36})\/reports\/([0-9a-f-]{36})\.csv$/;

let client: S3Client | undefined;
function s3(): S3Client {
  for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
    if (!process.env[name]) throw new Error(`Missing required configuration: ${name}`);
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  return client;
}

export function reportObjectKey(accountId: string, reportId: string): string {
  if (!UUID.test(accountId) || !UUID.test(reportId)) throw new Error('Invalid report identity');
  return `${accountId.toLowerCase()}/reports/${reportId.toLowerCase()}.csv`;
}

/** A stored key must belong to this workspace; anything else is refused. */
function assertOwnKey(accountId: string, key: string): void {
  const match = KEY.exec(key);
  if (!match || match[1] !== accountId.toLowerCase()) throw new Error('Report file belongs to another workspace');
}

/** Writes (or, on a retried job, overwrites) the report file. */
export async function putReportFile(accountId: string, key: string, body: Uint8Array): Promise<void> {
  assertOwnKey(accountId, key);
  await s3().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: body, ContentType: 'text/csv; charset=utf-8',
  }));
}

export async function getReportFile(accountId: string, key: string): Promise<ReadableStream<Uint8Array>> {
  assertOwnKey(accountId, key);
  const object = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  if (!object.Body) throw new Error('Report file is empty');
  return object.Body.transformToWebStream() as ReadableStream<Uint8Array>;
}

/** Deleting a missing object succeeds (S3 semantics), so the sweep can repeat safely. */
export async function deleteReportFile(accountId: string, key: string): Promise<void> {
  assertOwnKey(accountId, key);
  await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}
