import { Worker } from 'node:worker_threads'
import type { CollectInputNodeConfig } from './types'
/** Regex runs in an isolated thread with a deadline, so tenant-authored patterns
 * cannot monopolize the web or automation process. */
export async function validateCollectedInput(value: string, config: Pick<CollectInputNodeConfig, 'validation' | 'regex'>): Promise<boolean> {
  if (!value.trim() || value.length > 4096) return false
  if (!config.validation || config.validation === 'any') return true
  if (config.validation === 'email') return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value) && value.length <= 254
  if (config.validation === 'phone') return /^\+?[1-9][0-9]{7,14}$/.test(value)
  if (config.validation !== 'regex' || !config.regex || config.regex.length > 256) return false
  return new Promise(resolve => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{parentPort.postMessage(new RegExp('^(?:'+workerData.pattern+')$','u').test(workerData.value))}catch{parentPort.postMessage(false)}`, { eval: true, workerData: { pattern: config.regex, value }, resourceLimits: { maxOldGenerationSizeMb: 16 } })
    let settled = false
    const done = (result: boolean) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(result) }
    const timer = setTimeout(() => done(false), 200)
    worker.once('message', result => done(result === true))
    worker.once('error', () => done(false))
    worker.once('exit', () => done(false))
  })
}
