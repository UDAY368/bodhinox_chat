import { Worker } from 'node:worker_threads'
import type { CollectInputNodeConfig } from './types'
import { parseDateInput, parseNumberInput } from './input-formats'

export { parseDateInput, parseNumberInput }

type InputRules = Pick<CollectInputNodeConfig, 'validation' | 'regex' | 'min' | 'max'>

const YES = new Set(['yes', 'y', 'true', '1', 'si', 'sí', 'sim', '예', '네', 'ha', 'haan', 'हाँ', 'हां'])
const NO = new Set(['no', 'n', 'false', '0', 'não', 'nao', '아니요', '아니오', 'nahi', 'nahin', 'नहीं'])

/**
 * The value to store for a reply, or null when it does not match the
 * node's format. Number, date and boolean replies are normalized.
 */
export async function normalizeCollectedInput(raw: string, config: InputRules): Promise<string | null> {
  const value = raw.trim()
  if (!value || value.length > 4096) return null
  switch (config.validation ?? 'any') {
    case 'any':
      return value
    case 'email':
      return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value) && value.length <= 254 ? value : null
    case 'phone':
      return /^\+?[1-9][0-9]{7,14}$/.test(value) ? value : null
    case 'number': {
      const n = parseNumberInput(value)
      if (n === null) return null
      if (typeof config.min === 'number' && n < config.min) return null
      if (typeof config.max === 'number' && n > config.max) return null
      return String(n)
    }
    case 'date':
      return parseDateInput(value)
    case 'boolean': {
      const word = value.toLowerCase().replace(/[.!]+$/, '')
      return YES.has(word) ? 'true' : NO.has(word) ? 'false' : null
    }
    case 'regex':
      return config.regex && config.regex.length <= 256 && await regexMatches(config.regex, value, { anchored: true }) ? value : null
    default:
      return null
  }
}

export async function validateCollectedInput(value: string, config: InputRules): Promise<boolean> {
  return (await normalizeCollectedInput(value, config)) !== null
}

/** Regex runs in an isolated thread with a deadline, so tenant-authored patterns
 * cannot monopolize the web or automation process. Anchored for answers,
 * searched for keyword triggers. */
export function regexMatches(pattern: string, value: string, { anchored = false, caseSensitive = true } = {}): Promise<boolean> {
  if (pattern.length > 256 || value.length > 4096) return Promise.resolve(false)
  const source = anchored ? `^(?:${pattern})$` : pattern
  const flags = caseSensitive ? 'u' : 'iu'
  return new Promise(resolve => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{parentPort.postMessage(new RegExp(workerData.source,workerData.flags).test(workerData.value))}catch{parentPort.postMessage(false)}`, { eval: true, workerData: { source, flags, value }, resourceLimits: { maxOldGenerationSizeMb: 16 } })
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (result: boolean) => { if (settled) return; settled = true; clearTimeout(boot); clearTimeout(timer); void worker.terminate(); resolve(result) }
    // The 200 ms budget is for matching; thread start-up gets its own, looser cap.
    const boot = setTimeout(() => done(false), 2000)
    worker.once('online', () => { clearTimeout(boot); timer = setTimeout(() => done(false), 200) })
    worker.once('message', result => done(result === true))
    worker.once('error', () => done(false))
    worker.once('exit', () => done(false))
  })
}
