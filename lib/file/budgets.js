export const DEFAULT_FILE_BUDGETS = Object.freeze({
  timeoutMs: 30000,
  maxVisitedEntries: 100000,
  maxReadBytes: 256 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxOutputBytes: 96 * 1024,
  maxLineBytes: 4096,
})
const ranges = {
  timeoutMs: [50, 600000], maxVisitedEntries: [1, 1000000],
  maxReadBytes: [1, Number.MAX_SAFE_INTEGER], maxFileBytes: [1, 32 * 1024 * 1024],
  maxOutputBytes: [8192, 96 * 1024], maxLineBytes: [16, 16384],
}
export function resolveFileBudgets(raw = {}, fail = message => { throw new Error(message) }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('fileBudgets must be an object')
  const result = { ...DEFAULT_FILE_BUDGETS }
  for (const [key, value] of Object.entries(raw)) {
    const range = ranges[key]
    if (!range) return fail(`fileBudgets contains unknown key ${key}`)
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) return fail(`fileBudgets.${key} must be an integer in ${range[0]}..${range[1]}`)
    result[key] = value
  }
  return result
}
