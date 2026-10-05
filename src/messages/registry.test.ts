import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { isHarnessError } from '../errors.ts'
import { defineDataPart, invalidLocalName } from './data-parts.ts'
import { createKindMessage, defineMessageKind, isKindMessage, kindOf } from './kinds.ts'
import { createCoreMessageRegistry } from './registry.ts'

describe('core registry', () => {
  test('contains the core parts and kinds', () => {
    const registry = createCoreMessageRegistry()
    expect(registry.dataParts().map((p) => p.name)).toEqual([
      'eh.status',
      'eh.usage',
      'eh.context',
      'eh.warning',
      'eh.input',
      'eh.output',
      'eh.compaction',
      'eh.notice',
      'eh.event',
      'eh.rewind',
      'eh.flush',
    ])
    expect(registry.kinds().map((k) => k.name)).toEqual([
      'eh.compaction',
      'eh.notice',
      'eh.event',
      'eh.rewind',
      'eh.flush',
    ])
    expect(registry.dataPart('eh.status')?.def.transient).toBe(true)
    expect(registry.dataPart('data-eh.input')?.def.transient).toBeFalsy()
    expect(registry.kind('eh.compaction')?.def.boundary).toBe(true)
  })

  test('kinds are registered as persistent data parts', () => {
    const registry = createCoreMessageRegistry()
    const part = registry.dataPart('data-eh.compaction')
    expect(part?.kind?.name).toBe('eh.compaction')
    expect(part?.def.transient).toBe(false)
    expect(Object.keys(registry.dataSchemas())).toContain('eh.compaction')
  })

  test('collisions throw EH_DUPLICATE_DATA_PART naming both owners', () => {
    const registry = createCoreMessageRegistry()
    registry.registerDataPart('fs.change', defineDataPart({ schema: z.object({}) }), 'fs')
    try {
      registry.registerKind(
        'fs.change',
        defineMessageKind({ role: 'user', schema: z.object({}) }),
        'other',
      )
      throw new Error('expected a throw')
    } catch (error) {
      expect(isHarnessError(error, 'EH_DUPLICATE_DATA_PART')).toBe(true)
      expect((error as Error).message).toContain("plugin 'fs'")
      expect((error as Error).message).toContain("plugin 'other'")
      expect((error as Error).message).toContain('data-fs.change')
    }
  })
})

describe('names', () => {
  test('local name rules', () => {
    expect(invalidLocalName('invoice')).toBeUndefined()
    expect(invalidLocalName('myPart-2')).toBeUndefined()
    expect(invalidLocalName('a.b')).toBeDefined()
    expect(invalidLocalName('Invoice')).toBeDefined()
    expect(invalidLocalName('ehlo')).toBeDefined()
    expect(invalidLocalName('')).toBeDefined()
  })
})

describe('kind messages', () => {
  test('createKindMessage builds the normative shape', () => {
    const message = createKindMessage(
      'eh.event',
      { name: 'deploy', text: 'done' },
      { id: 'm1', createdAt: 1, turnId: 't1' },
    )
    expect(message).toEqual({
      id: 'm1',
      role: 'user',
      metadata: { eharness: { v: 1, createdAt: 1, kind: 'eh.event', turnId: 't1' } },
      parts: [{ type: 'data-eh.event', data: { name: 'deploy', text: 'done' } }],
    })
    expect(isKindMessage(message)).toBe(true)
    expect(isKindMessage(message, 'eh.event')).toBe(true)
    expect(isKindMessage(message, 'eh.notice')).toBe(false)
    expect(kindOf(message)).toBe('eh.event')
  })

  test('role defaults to the core kind role', () => {
    expect(createKindMessage('eh.notice', { level: 'info', message: 'x' }).role).toBe('assistant')
    expect(createKindMessage('app-thing', {}).role).toBe('user')
    expect(createKindMessage('app-thing', {}, { role: 'assistant' }).role).toBe('assistant')
  })

  test('kind and part type must agree', () => {
    const message = createKindMessage('eh.event', { name: 'a', text: 'b' })
    const broken = { ...message, parts: [{ type: 'data-eh.notice', data: {} }] }
    expect(isKindMessage(broken)).toBe(false)
    expect(isKindMessage({ ...message, parts: [...message.parts, ...message.parts] })).toBe(false)
    expect(isKindMessage({ metadata: message.metadata, parts: [] })).toBe(false)
  })
})
