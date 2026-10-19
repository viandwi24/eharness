/** Approval answers typed in chat: the yes / no words and the "all" suffix (pure). */

const YES_WORDS = new Set([
  'ya',
  'iya',
  'iyah',
  'iyaa',
  'y',
  'yes',
  'yep',
  'ok',
  'oke',
  'okay',
  'okey',
  'okee',
  'sip',
  'siap',
  'boleh',
  'setuju',
  'acc',
  'approve',
  'approved',
  'gas',
  'gass',
  'lanjut',
  'lanjutkan',
  'kirim',
  'kirimkan',
  'send',
  'go',
  'silakan',
  'silahkan',
  'betul',
  'benar',
  '👍',
  '✅',
  '👌',
])
const NO_WORDS = new Set([
  'tidak',
  'tdk',
  'ga',
  'gak',
  'nggak',
  'enggak',
  'engga',
  'jangan',
  'no',
  'n',
  'nope',
  'batal',
  'batalkan',
  'cancel',
  'tolak',
  'deny',
  'denied',
  'stop',
  'gausah',
  'gaperlu',
  '❌',
  '👎',
  '🚫',
])

/**
 * A short reply that is plainly yes or no ("ya", "ok gas", "tidak", "batal"), else undefined.
 * Anything longer or mixed is a new message, never an answer.
 */
export function approvalWord(text: string): 'yes' | 'no' | undefined {
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:"'()[\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0 || words.length > 4) return undefined
  if (words.every((w) => YES_WORDS.has(w))) return 'yes'
  if (words.every((w) => NO_WORDS.has(w))) return 'no'
  return undefined
}

/** Added to every approval request: the one-line way to stop being asked about the same tool. */
export const ASK_ALL_LINE =
  '\nReply "ya semua" / "yes all" to approve this tool for the rest of this session too.'

const ALL_WORDS = new Set(['semua', 'all', 'selalu', 'always', 'aja', 'saja', 'terus'])

/**
 * "ya semua" / "yes all" / "selalu" / "always": a yes that also covers the next calls of the same
 * tool in this session. Undefined for anything else (a plain "ya" is a single answer).
 */
export function approvalRemembers(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:"'()[\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0 || words.length > 4) return false
  if (!words.some((w) => ALL_WORDS.has(w))) return false
  return words.every((w) => ALL_WORDS.has(w) || YES_WORDS.has(w))
}
