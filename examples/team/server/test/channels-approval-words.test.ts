import { describe, expect, test } from 'bun:test'
import { approvalRemembers, approvalWord } from '../src/infra/channels/gateway.ts'

describe('approval replies', () => {
  test('"ya semua", "yes all", "selalu" and "always" remember for the session', () => {
    for (const t of ['ya semua', 'Yes all', 'selalu', 'always', 'ok selalu aja', 'ya, semua!'])
      expect(approvalRemembers(t)).toBe(true)
  })

  test('a plain yes, a no and a sentence do not', () => {
    for (const t of ['ya', 'tidak', 'semua orang setuju kok itu', 'jangan semua', 'all done'])
      expect(approvalRemembers(t)).toBe(false)
    expect(approvalWord('ya semua')).toBeUndefined()
  })
})
