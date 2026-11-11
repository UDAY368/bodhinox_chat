// Stage 5 (5G): the google_sheets flow step (5B calls executeSheetsNode).
//
//   insert_row   appends one row (values under their columns)
//   get_row      finds the first row whose match column equals the match value
//                and maps its columns to run variables (read only)
//   update_row   finds that row and writes the given cells
//
// Columns are letters (A … ZZ) or header names in row 1. Values may use
// {{vars.x}} and {{workspace.key}} (non-secret attributes only); they are
// written RAW, so a value starting with "=" is stored as text, never run as a
// formula. Requests go to the fixed Google hosts with a timeout.
//
// Writes are idempotent per run, step and transition: each runs under an
// outbound intent (`sheets:<run>:<step>:<seq>`) whose result is stored after
// Google answered. A retry of a finished write returns the stored result and
// never inserts a second row; an earlier attempt whose outcome is unknown
// (timeout, server error, crash mid-request) is never retried automatically:
// the step follows its failure port with `sheets_outcome_unknown`, for a person
// to check the sheet. Cell values, spreadsheet ids and tokens are never logged.

import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { fillWorkspace, workspaceValuesFor } from '@/lib/workspace/attributes';
import type { FlowNodeRow, FlowRunRow, GoogleSheetsNodeConfig } from '@/lib/flows/types';
import { FLOW_STEP_LIMITS } from '@/lib/flows/types';
import { googleSheetsEnabled } from './config';
import { sheetsAccessToken } from './connection';
import {
  buildAppendRequest, buildReadRequest, buildUpdateRequest, findRow, isSheetName, isSpreadsheetId, needsHeader,
  resolveColumn, rowFor, SHEETS_LOOKUP_ROWS, sheetsCall, SheetsHttpError,
} from './api';

export interface SheetsNodeResult {
  /** `next` on success, `failure` otherwise (unknown outcome included). */
  port: 'next' | 'failure';
  /** Run variables set by a get_row step (var_map). */
  vars: Record<string, string>;
  /** A machine reason for the run event, never a cell value. */
  reason?: 'not_connected' | 'not_enabled' | 'sheets_outcome_unknown' | 'sheets_failed' | 'not_found';
}

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CELL_MAX = 5_000;

const fail = (reason: NonNullable<SheetsNodeResult['reason']>): SheetsNodeResult => {
  console.info('[google sheets step] failure', { reason });
  return { port: 'failure', vars: {}, reason };
};

/** Why a step's config cannot run, or null (shared with the validator and the form). */
export function sheetsConfigProblem(raw: unknown): 'op' | 'spreadsheet_id' | 'sheet' | 'columns' | 'match' | 'var_map' | null {
  const cfg = raw as Partial<GoogleSheetsNodeConfig> | null;
  if (!cfg || !['insert_row', 'get_row', 'update_row'].includes(String(cfg.op))) return 'op';
  if (!isSpreadsheetId(cfg.spreadsheet_id)) return 'spreadsheet_id';
  if (!isSheetName(cfg.sheet)) return 'sheet';
  const columns = Array.isArray(cfg.columns) ? cfg.columns : [];
  const columnOk = (c: unknown) => {
    const v = c as { column?: unknown; value?: unknown } | null;
    return !!v && typeof v.column === 'string' && v.column.trim().length > 0 && v.column.length <= 100
      && typeof v.value === 'string' && v.value.length <= CELL_MAX;
  };
  if (columns.length > FLOW_STEP_LIMITS.sheetColumns || !columns.every(columnOk)) return 'columns';
  if (cfg.op !== 'get_row' && columns.length === 0) return 'columns';
  if (cfg.op !== 'insert_row' && (!cfg.match || !columnOk(cfg.match) || !cfg.match.value.trim())) return 'match';
  if (cfg.op === 'get_row') {
    const map = Array.isArray(cfg.var_map) ? cfg.var_map : [];
    if (!map.length || map.length > FLOW_STEP_LIMITS.sheetColumns || !map.every((m) => !!m && typeof m.column === 'string'
      && m.column.trim().length > 0 && m.column.length <= 100 && typeof m.var_key === 'string' && VAR_KEY.test(m.var_key))) return 'var_map';
  }
  return null;
}

/** `{{vars.x}}` then workspace placeholders; run variables never expand placeholders themselves. */
export function fillValue(template: string, vars: Record<string, unknown>, workspace: Record<string, string>): string {
  return fillWorkspace(template, workspace).replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  }).slice(0, CELL_MAX);
}

/** What a write intent stores: the outcome only, never a value. */
type StoredWrite = { ok: true } | { ok: false; reason: 'sheets_failed' | 'not_found' };

/** Runs a Google Sheets step. Never throws. */
export async function executeSheetsNode(run: FlowRunRow, node: FlowNodeRow): Promise<SheetsNodeResult> {
  try {
    if (!googleSheetsEnabled()) return fail('not_enabled');
    const cfg = node.config as unknown as GoogleSheetsNodeConfig;
    if (sheetsConfigProblem(cfg)) return fail('sheets_failed');
    const token = await sheetsAccessToken(run.account_id);
    if (!token.ok) return fail(token.reason);

    const templates = [...cfg.columns.map((c) => c.value), cfg.match?.value ?? ''].join(' ');
    const workspace = await workspaceValuesFor(run.account_id, templates);
    const cells = cfg.columns.map((c) => ({ column: c.column.trim(), value: fillValue(c.value, run.vars, workspace) }));
    const matchValue = cfg.match ? fillValue(cfg.match.value, run.vars, workspace) : '';
    const refs = [...cells.map((c) => c.column), ...(cfg.match ? [cfg.match.column.trim()] : []), ...(cfg.var_map ?? []).map((m) => m.column.trim())];
    const readRows = async (rows: number) => (await sheetsCall<{ values?: unknown[][] }>(token.token,
      buildReadRequest(cfg.spreadsheet_id, cfg.sheet, rows))).values ?? [];

    if (cfg.op === 'get_row') {
      let rows: unknown[][];
      try {
        rows = await readRows(SHEETS_LOOKUP_ROWS);
      } catch {
        return fail('sheets_failed');
      }
      const header = (rows[0] ?? []).map((v) => String(v ?? ''));
      const matchIndex = resolveColumn(cfg.match!.column, header);
      if (matchIndex === null) return fail('sheets_failed');
      const rowNumber = findRow(rows, matchIndex, matchValue);
      if (rowNumber === null) return fail('not_found');
      const row = rows[rowNumber - 1] ?? [];
      const vars: Record<string, string> = {};
      for (const m of cfg.var_map ?? []) {
        const index = resolveColumn(m.column, header);
        if (index === null) return fail('sheets_failed');
        vars[m.var_key] = String(row[index] ?? '').slice(0, CELL_MAX);
      }
      return { port: 'next', vars };
    }

    // Writes: one intent per run, step and transition.
    const key = `sheets:${run.id}:${node.node_key}:${run.transition_seq ?? 0}`;
    let stored: StoredWrite;
    try {
      stored = await dispatchOnce<StoredWrite>(run.account_id, key, async () => {
        // Reading is safe to repeat; a certain refusal (4xx) before the write is stored as a failure.
        let rows: unknown[][] = [];
        try {
          if (cfg.op === 'update_row') rows = await readRows(SHEETS_LOOKUP_ROWS);
          else if (needsHeader(refs)) rows = await readRows(1);
        } catch {
          // Nothing was written yet: any read fault is a certain "not written".
          return { ok: false, reason: 'sheets_failed' };
        }
        const header = (rows[0] ?? []).map((v) => String(v ?? ''));
        const placed: Array<{ index: number; value: string }> = [];
        for (const c of cells) {
          const index = resolveColumn(c.column, header);
          if (index === null) return { ok: false, reason: 'sheets_failed' };
          placed.push({ index, value: c.value });
        }
        let request;
        if (cfg.op === 'insert_row') {
          request = buildAppendRequest(cfg.spreadsheet_id, cfg.sheet, rowFor(placed));
        } else {
          const matchIndex = resolveColumn(cfg.match!.column, header);
          if (matchIndex === null) return { ok: false, reason: 'sheets_failed' };
          const rowNumber = findRow(rows, matchIndex, matchValue);
          if (rowNumber === null) return { ok: false, reason: 'not_found' };
          request = buildUpdateRequest(cfg.spreadsheet_id, cfg.sheet, rowNumber, placed);
        }
        try {
          await sheetsCall(token.token, request);
        } catch (error) {
          // Google refused it (4xx): certainly not written. Anything else is an unknown outcome (thrown: intent 'unknown').
          if (error instanceof SheetsHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
            return { ok: false, reason: 'sheets_failed' };
          throw error;
        }
        return { ok: true };
      });
    } catch (error) {
      if (error instanceof UncertainDispatchError) return fail('sheets_outcome_unknown');
      throw error;
    }
    return stored.ok ? { port: 'next', vars: {} } : fail(stored.reason);
  } catch (error) {
    console.warn('[google sheets step] failed', { error: error instanceof Error ? error.name : 'unknown' });
    return fail('sheets_failed');
  }
}
