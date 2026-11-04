import { describe, expect, it } from 'vitest';
import { isReportFileResponse, needsSignIn } from './report-download';

const response = (status: number, type: string, redirected = false) =>
  Object.defineProperty(new Response('x', { status, headers: { 'content-type': type } }), 'redirected', { value: redirected });

describe('shared report download', () => {
  it('saves only a PDF or CSV answered directly', () => {
    expect(isReportFileResponse(response(200, 'application/pdf'))).toBe(true);
    expect(isReportFileResponse(response(200, 'text/csv; charset=utf-8'))).toBe(true);
    // The sign-in page reached through a followed redirect is not the report.
    expect(isReportFileResponse(response(200, 'text/html; charset=utf-8', true))).toBe(false);
    expect(isReportFileResponse(response(200, 'application/pdf', true))).toBe(false);
    expect(isReportFileResponse(response(200, 'text/html'))).toBe(false);
    expect(isReportFileResponse(response(500, 'application/pdf'))).toBe(false);
  });

  it('asks to sign in again after a 401 or a followed redirect', () => {
    expect(needsSignIn(response(401, 'application/json'))).toBe(true);
    expect(needsSignIn(response(200, 'text/html', true))).toBe(true);
    expect(needsSignIn(response(404, 'application/json'))).toBe(false);
  });
});
