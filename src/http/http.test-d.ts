/**
 * Type-level tests of the principal type `P` of `eharness/http` (0.8), checked by `tsc --noEmit`
 * (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { createHarnessHttp, type HarnessHttpOptions, openAccess } from './index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

interface Principal {
  id: string
  roles: string[]
}

// the principal returned by `authorize` reaches every other hook with the same type
createHarnessHttp<Principal>(undefined, {
  authorize: ({ request }) =>
    request.headers.has('authorization')
      ? { id: 'u1', roles: ['admin'] }
      : { deny: 401, code: 'UNAUTHORIZED' },
  session: async (_id, ctx) => {
    type _Ctx = Expect<Equal<typeof ctx.principal, Principal>>
    ctx.principal.roles.includes('admin')
    throw new Error('not used')
  },
  peek: async (_id, ctx) => {
    type _Ctx = Expect<Equal<typeof ctx.principal, Principal>>
    throw new Error('not used')
  },
  chat: {
    actorOf: (principal) => {
      type _P = Expect<Equal<typeof principal, Principal>>
      return { id: principal.id }
    },
    authorizeKind: ({ principal }) => {
      type _P = Expect<Equal<typeof principal, Principal>>
      return undefined
    },
  },
  attention: {
    roots: ({ principal }) => {
      type _P = Expect<Equal<typeof principal, Principal>>
      return [`dm:${principal.id}`]
    },
    peek: () => {
      throw new Error('not used')
    },
    open: (_sessionId, { principal }) => {
      type _P = Expect<Equal<typeof principal, Principal>>
      throw new Error('not used')
    },
    canAnswer: ({ principal }) => principal.roles.length > 0,
  },
})

// `openAccess` has no principal (`undefined`)
createHarnessHttp(undefined, {
  authorize: openAccess,
  chat: {
    actorOf: (principal) => {
      type _P = Expect<Equal<typeof principal, undefined>>
      return undefined
    },
  },
})

// the type argument is inferred from `authorize`
type Inferred = HarnessHttpOptions<Principal>
type _Authorize = Expect<
  Equal<
    Awaited<ReturnType<Inferred['authorize']>>,
    Principal | { deny: 401 | 403 | 404; code?: string; message?: string } | Response
  >
>

// a hook that wants another principal type does not compile
createHarnessHttp<Principal>(undefined, {
  authorize: () => ({ id: 'u1', roles: [] }),
  chat: {
    // @ts-expect-error the principal is a Principal, not a string
    actorOf: (principal: string) => ({ id: principal }),
  },
})
// @ts-expect-error authorize must return a Principal (or a denial)
createHarnessHttp<Principal>(undefined, { authorize: () => 'nobody' })
