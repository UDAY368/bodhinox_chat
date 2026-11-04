// Client-safe checks for downloading a report file through fetch.

/**
 * Whether a download response is the report file itself. A redirect that
 * fetch followed (to the sign-in page) or any other content type is not: it
 * must never be saved as the report.
 */
export function isReportFileResponse(res: Pick<Response, 'ok' | 'redirected' | 'headers'>): boolean {
  if (!res.ok || res.redirected) return false;
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  return type.startsWith('application/pdf') || type.startsWith('text/csv');
}

/** Whether the response means the session is gone and the member must sign in again. */
export function needsSignIn(res: Pick<Response, 'status' | 'redirected'>): boolean {
  return res.status === 401 || res.redirected;
}
