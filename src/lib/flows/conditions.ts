// Condition node rules, kept pure so they can be tested without a database.

import { isValidTimeZone, isWithinTimeWindow } from '@/lib/automations/time-of-day'
import { parseDateInput, parseNumberInput } from './input-formats'
import type { ConditionNodeConfig, ConditionOperator, ConditionRule } from './types'

export interface RuleClock { now: Date; timezone: string }

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** The node's rules; a node saved before rules existed is a single rule. */
export function conditionRules(cfg: ConditionNodeConfig): ConditionRule[] {
  if (Array.isArray(cfg.rules) && cfg.rules.length) return cfg.rules
  return [{ subject: cfg.subject ?? 'var', subject_key: cfg.subject_key ?? '', operator: cfg.operator ?? 'equals', value: cfg.value, value2: cfg.value2 }]
}

export function clockTimezone(cfg: Pick<ConditionNodeConfig, 'timezone'>): string {
  return isValidTimeZone(cfg.timezone) ? cfg.timezone : 'UTC'
}

/** "HH:MM" or "YYYY-MM-DD" right now in the timezone. */
export function clockValue(subject: 'time' | 'date', clock: RuleClock): string {
  if (subject === 'date') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: clock.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now)
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: clock.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(clock.now)
  const part = (type: string) => (parts.find((p) => p.type === type)?.value ?? '00').padStart(2, '0')
  return `${part('hour') === '24' ? '00' : part('hour')}:${part('minute')}`
}

/** Orders two values as numbers, then dates, then clock times; null when they are not comparable. */
export function compareValues(a: string, b: string): number | null {
  const na = parseNumberInput(a), nb = parseNumberInput(b)
  if (na !== null && nb !== null) return Math.sign(na - nb)
  const da = parseDateInput(a), db = parseDateInput(b)
  if (da && db) return da < db ? -1 : da > db ? 1 : 0
  if (CLOCK.test(a) && CLOCK.test(b)) return a < b ? -1 : a > b ? 1 : 0
  return null
}

/**
 * One test. A missing subject (undefined) fails every operator except
 * `absent`; an empty string counts as missing only for present/absent.
 * Ordering operators need both sides to be numbers, dates or clock times.
 */
export function predicateHolds(operator: ConditionOperator, subject: string | undefined, value = '', value2 = ''): boolean {
  if (operator === 'present') return subject !== undefined && subject !== ''
  if (operator === 'absent') return subject === undefined || subject === ''
  if (subject === undefined) return false
  switch (operator) {
    case 'equals': return subject === value
    case 'not_equals': return subject !== value
    case 'contains': return subject.includes(value)
    case 'gt': { const c = compareValues(subject, value); return c !== null && c > 0 }
    case 'gte': { const c = compareValues(subject, value); return c !== null && c >= 0 }
    case 'lt': { const c = compareValues(subject, value); return c !== null && c < 0 }
    case 'lte': { const c = compareValues(subject, value); return c !== null && c <= 0 }
    case 'between': {
      const lo = compareValues(subject, value), hi = compareValues(subject, value2)
      return lo !== null && hi !== null && lo >= 0 && hi <= 0
    }
    default: return false
  }
}

/** A rule against its resolved subject; `time` / `date` rules read the clock instead. */
export function ruleHolds(rule: ConditionRule, subject: string | undefined, clock: RuleClock): boolean {
  if (rule.subject === 'time' && rule.operator === 'between') {
    // A window may cross midnight (22:00–06:00); the end minute is excluded.
    return isWithinTimeWindow(`${rule.value ?? ''}-${rule.value2 ?? ''}`, clock.now, clock.timezone)
  }
  const value = rule.subject === 'time' || rule.subject === 'date' ? clockValue(rule.subject, clock) : subject
  // Day-first dates (25/12/2026) pass validation, so compare them as ISO like the clock value.
  const bound = (v?: string) => (rule.subject === 'date' && v ? parseDateInput(v) ?? v : v)
  return predicateHolds(rule.operator, value, bound(rule.value), bound(rule.value2))
}
