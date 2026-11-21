// The one definition of response time, used by every screen and report that
// shows it (home dashboard, analytics tabs, team leaderboard, operations panel,
// day-wise agent report, AI insights and the daily rollup). Shown everywhere as
// "Median first reply".
//
// First reply time: from a customer's inbound message that starts or reopens a
// waiting period to the next human or AI reply in the same conversation, in
// wall-clock time (no business hours), median shown.
// - A reply is a message that did not fail and is not a template or system
//   note, sent by a member (sender_type 'agent') or by the AI (ai_generated).
//   Flow, automation and other bot messages do not end a wait.
// - A waiting period starts at the first customer message after a reply (or the
//   conversation's first customer message); further customer messages before a
//   reply belong to the same wait.
// - A wait belongs to the range its first message falls in. Messages up to
//   FIRST_REPLY_WINDOW before the range are read to tell whether an in-range
//   customer message starts a wait or continues one; replies up to
//   FIRST_REPLY_WINDOW after the range end a wait that started inside it. A
//   wait with no reply in that window is unanswered.
//
// firstRepliesSql emits CTEs ending in
//   first_replies(conversation_id, wait_at, reply_at, replier_type, replier_id, secs)
// with replier_type 'agent' | 'ai' | NULL (unanswered) and secs NULL when unanswered.

import { Prisma } from '@prisma/client';

export const FIRST_REPLY_LABEL = 'Median first reply';
export const FIRST_REPLY_WINDOW = Prisma.sql`interval '7 days'`;

/** A message row (alias `m`) that ends a wait. */
export const isFirstReplyMessage = (m: string) => Prisma.raw(
  `(${m}.status <> 'failed' AND ${m}.content_type NOT IN ('template','system')
    AND (${m}.sender_type='agent' OR (${m}.sender_type <> 'customer' AND ${m}.ai_generated)))`);

/**
 * CTEs fr_msgs, fr_waits and first_replies for waits starting in [from, to).
 * `conversations` optionally narrows the scan (e.g. `AND m.conversation_id IN (SELECT id FROM scope)`).
 */
export function firstRepliesSql(accountId: string, from: Prisma.Sql, to: Prisma.Sql,
  conversations: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    fr_msgs AS (
      SELECT m.conversation_id, m.created_at, m.sender_id,
        CASE WHEN m.sender_type='customer' THEN 'customer' WHEN m.sender_type='agent' THEN 'agent' ELSE 'ai' END AS kind,
        count(*) FILTER (WHERE m.sender_type <> 'customer')
          OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.arrival_sequence, m.id) AS seg
      FROM messages m
      WHERE m.account_id=${accountId}::uuid
        AND m.created_at >= ${from} - ${FIRST_REPLY_WINDOW} AND m.created_at < ${to} + ${FIRST_REPLY_WINDOW}
        AND (m.sender_type='customer' OR ${isFirstReplyMessage('m')}) ${conversations}
    ), fr_waits AS (
      SELECT conversation_id, seg, min(created_at) AS wait_at FROM fr_msgs
      WHERE kind='customer' GROUP BY conversation_id, seg
    ), fr_answers AS (
      SELECT DISTINCT ON (conversation_id, seg) conversation_id, seg, created_at AS reply_at, kind, sender_id
      FROM fr_msgs WHERE kind <> 'customer' ORDER BY conversation_id, seg, created_at
    ), first_replies AS (
      SELECT w.conversation_id, w.wait_at, a.reply_at, a.kind AS replier_type,
        CASE WHEN a.kind='agent' THEN a.sender_id END AS replier_id,
        extract(epoch FROM (a.reply_at - w.wait_at))::float8 AS secs
      FROM fr_waits w LEFT JOIN fr_answers a ON a.conversation_id=w.conversation_id AND a.seg=w.seg+1
      WHERE w.wait_at >= ${from} AND w.wait_at < ${to}
    )`;
}

/** Median of `secs` over first_replies (or any alias with secs), whole seconds, NULL without answered waits. */
export const medianSecondsSql = (filter: Prisma.Sql = Prisma.empty) =>
  Prisma.sql`round((percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) ${filter})::numeric)::int`;

/** Median of a list of second counts (the same rule as percentile_cont(0.5)), rounded. */
export function medianOf(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  const lo = sorted[Math.floor(mid)], hi = sorted[Math.ceil(mid)];
  return Math.round(lo + (hi - lo) * (mid - Math.floor(mid)));
}
