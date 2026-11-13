// Send now on a scheduled campaign: what happens to its initial dispatch job.
import { describe, expect, it } from 'vitest';
import { planSendNow } from './schedule';

describe('planSendNow', () => {
  it('moves a waiting job to now', () => {
    expect(planSendNow({ jobStatus: 'pending', held: false, canRebuildJob: false })).toEqual({ kind: 'move' });
  });

  it('queues the same job again when it ran without starting the campaign', () => {
    expect(planSendNow({ jobStatus: 'done', held: false, canRebuildJob: false })).toEqual({ kind: 'requeue' });
    expect(planSendNow({ jobStatus: 'failed', held: false, canRebuildJob: false })).toEqual({ kind: 'requeue' });
  });

  it('says a running job is already starting', () => {
    expect(planSendNow({ jobStatus: 'running', held: false, canRebuildJob: true })).toMatchObject({ kind: 'refuse', code: 'already_starting' });
  });

  it('writes a new job when the old one is gone only if nothing it carried is lost', () => {
    expect(planSendNow({ jobStatus: null, held: false, canRebuildJob: true })).toEqual({ kind: 'insert' });
    expect(planSendNow({ jobStatus: null, held: false, canRebuildJob: false })).toMatchObject({ kind: 'refuse', code: 'job_missing' });
  });

  it('refuses while the workspace is held, whatever the job state, instead of claiming it is starting', () => {
    for (const jobStatus of ['pending', 'done', null])
      expect(planSendNow({ jobStatus, held: true, canRebuildJob: true })).toMatchObject({ kind: 'refuse', code: 'workspace_held' });
  });
});
