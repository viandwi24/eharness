/**
 * The "Telegram account" connector (P41 L4): sign a Telegram *user account* in through a custom
 * flow, then choose the chats to ingest.
 *
 *   app      api_id / api_hash (workspace config: env or saved once; asked only when missing)
 *   method   phone number, and how to sign in (a code, or a QR scanned in the Telegram app)
 *   code     the login code (with "resend"); wrong or expired codes keep the form
 *   qr       a rotating login token shown as a QR code
 *   password two-step verification password, only when the account has one; never persisted
 *   test     getMe: the account label
 *   choose   the chats to ingest (several)
 *
 * The session string ends up only in `ConnectionCredentials.session` (sealed by the credential
 * store); it is never in a view, the flow state or a log. The selected chats and the account
 * identity are the connection's settings (sealed with the profile store like every setting).
 *
 * WARNING shown to the person: driving a user account with an API client can get the account
 * limited or banned. Use a dedicated account and read Telegram's terms (links in `docsUrl` and on
 * the Channels page).
 */
import { type AnyConnectorDefinition, defineConnector, type FlowStepDef } from 'eharness/connectors'
import { ehMeta, formSpec } from 'eharness/providers'
import { z } from 'zod'
import type { TgChat, TgUser } from './client.ts'
import { classifyError, describeError } from './errors.ts'
import type { LoginSessions } from './login.ts'

export const TELEGRAM_USER_CONNECTOR_ID = 'telegram-user'
export const SESSION_FORMAT = 'mtcute-string'
export const TERMS_URL = 'https://core.telegram.org/api/terms'
export const OBTAINING_API_ID_URL = 'https://core.telegram.org/api/obtaining_api_id'

/** What the connection keeps as settings (sealed): the account and the chats chosen while connecting. */
export interface UserConnectionSettings {
  accountId?: string
  username?: string
  phone?: string
  chats?: Array<{ id: string; title: string; kind: string; admin: boolean; forum: boolean }>
}

export interface TelegramApp {
  apiId: number
  apiHash: string
}

export interface UserConnectorOptions {
  logins: LoginSessions
  /** Saves the api id / hash the person typed for the whole workspace (sealed). */
  saveApp?: (app: TelegramApp) => Promise<void>
  /** Poll interval of the QR view (ms, default 2000). */
  qrPollMs?: number
  /** Longest the QR / 2FA step waits for an answer inside one request (ms, default 8000). */
  settleMs?: number
}

const AppSchema = z.object({
  apiId: z.string().meta({
    title: 'api_id',
    description: `The number from my.telegram.org/apps (log in with the account's phone number, then "API development tools"). One per account; keep it private.`,
    ...ehMeta({ group: 'auth', placeholder: '1234567' }),
  }),
  apiHash: z.string().meta({
    title: 'api_hash',
    description: 'The 32-character hash next to the api_id. Stored encrypted for the workspace.',
    ...ehMeta({ group: 'auth', secret: true, widget: 'password' }),
  }),
})

const MethodSchema = z.object({
  method: z
    .enum(['code', 'qr'])
    .default('code')
    .meta({
      title: 'Sign in with',
      description:
        'A code Telegram sends to the account, or a QR code you scan in the Telegram app (Settings, Devices, Link Desktop Device).',
      ...ehMeta({ group: 'auth' }),
    }),
  phone: z
    .string()
    .optional()
    .meta({
      title: 'Phone number',
      description:
        'The dedicated account, in international format (+62812...). Not needed for a QR sign-in.',
      ...ehMeta({ group: 'auth', placeholder: '+62812…' }),
    }),
})

const CodeSchema = z.object({
  code: z.string().meta({
    title: 'Login code',
    description: 'The code Telegram sent to the account (in the Telegram app, or by SMS).',
    ...ehMeta({ group: 'auth', placeholder: '12345' }),
  }),
})

const PasswordSchema = z.object({
  password: z.string().meta({
    title: 'Two-step verification password',
    description: 'Used once to sign in. It is never stored.',
    ...ehMeta({ group: 'auth', secret: true, widget: 'password' }),
  }),
})

const fieldsOf = (schema: z.ZodObject) => formSpec(schema).fields

export const normalizePhone = (input: string): string | undefined => {
  const digits = input.replace(/[\s().-]/g, '')
  if (!/^\+?\d{6,15}$/.test(digits)) return undefined
  return digits.startsWith('+') ? digits : `+${digits}`
}

const parseApp = (value: unknown): TelegramApp | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const id = typeof v.apiId === 'number' ? v.apiId : Number(String(v.apiId ?? '').trim())
  const hash = String(v.apiHash ?? '').trim()
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return undefined
  if (!/^[0-9a-fA-F]{32}$/.test(hash)) return undefined
  return { apiId: id, apiHash: hash.toLowerCase() }
}

export { parseApp as parseTelegramApp }

export const accountLabel = (u: TgUser): string =>
  `${u.username === undefined ? u.name : `@${u.username}`}${u.phone === undefined ? '' : ` (+${u.phone.replace(/^\+/, '')})`}`

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const chatOption = (c: TgChat): { value: string; label: string; description: string } => ({
  value: c.id,
  label: clip(c.title || c.id, 80),
  description: `${c.kind === 'dm' ? 'person' : c.kind}${c.forum ? ', forum' : ''}${c.admin ? ', you are an admin' : ''}${c.members === undefined ? '' : `, ${c.members} members`}`,
})

export function telegramUserConnector(options: UserConnectorOptions): AnyConnectorDefinition {
  const qrPollMs = options.qrPollMs ?? 2000
  const settleMs = options.settleMs ?? 8000
  const { logins } = options

  type Ctx = Parameters<FlowStepDef['view']>[0]

  const appOf = async (ctx: Ctx): Promise<TelegramApp | undefined> => {
    const fromScratch = parseApp(ctx.scratch.app)
    if (fromScratch !== undefined) return fromScratch
    const configured = await ctx.deps.clientConfig(ctx.definition.id, {
      flowId: ctx.flowId,
      scope: ctx.scope,
      scopeId: ctx.scopeId,
      reconnect: ctx.reconnect,
      settings: {},
    })
    return parseApp(configured)
  }

  const sessionOf = (ctx: Ctx) => {
    const s = logins.get(ctx.flowId)
    if (s === undefined) return undefined
    return s
  }

  /** The step for a lost in-memory login (the process restarted, or the login expired). */
  const lost = {
    error: 'This sign-in expired or the server restarted. Start again.',
    retryable: false,
  }

  const steps: FlowStepDef[] = [
    {
      id: 'app',
      skip: async (ctx) => (await appOf(ctx)) !== undefined,
      view: (ctx) => ({
        type: 'form',
        title: 'Telegram API credentials',
        description: `Telegram needs an api_id and api_hash for this app, from my.telegram.org/apps (${OBTAINING_API_ID_URL}). Set them once for the workspace; use a dedicated account, enable two-step verification, and read the terms of Telegram's API (${TERMS_URL}): signing in a user account with an API client can get the account limited or banned.`,
        fields: fieldsOf(AppSchema),
        values: { apiId: String(ctx.scratch.appDraftId ?? '') },
        ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
        ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
        submitLabel: 'Continue',
      }),
      advance: async (ctx, { action, data }) => {
        if (action !== 'submit') return { pending: true }
        const app = parseApp(data)
        ctx.scratch.appDraftId = data.apiId === undefined ? '' : String(data.apiId)
        if (app === undefined) {
          return {
            stay: true,
            errors: {
              apiId: 'The api_id is a number.',
              apiHash: 'The api_hash is 32 hexadecimal characters.',
            },
          }
        }
        ctx.scratch.app = app
        delete ctx.scratch.appDraftId
        try {
          await options.saveApp?.(app)
        } catch {
          // not saved for the workspace: this flow still has it
        }
        return { next: true }
      },
    },
    {
      id: 'method',
      view: (ctx) => ({
        type: 'form',
        title: 'Sign in to Telegram',
        description:
          'Use a dedicated account (not a personal one). Ban risk: Telegram may limit or ban accounts driven by API clients; the Channels page lists the safeguards and the terms.',
        fields: fieldsOf(MethodSchema),
        values: {
          method: String(ctx.scratch.method ?? 'code'),
          phone: String(ctx.scratch.phone ?? ''),
        },
        ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
        ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
        submitLabel: 'Continue',
      }),
      advance: async (ctx, { action, data }) => {
        if (action !== 'submit') return { pending: true }
        const app = await appOf(ctx)
        if (app === undefined) return { goto: 'app' }
        const method = data.method === 'qr' ? 'qr' : 'code'
        const rawPhone = String(data.phone ?? '').trim()
        const phone = rawPhone === '' ? undefined : normalizePhone(rawPhone)
        if (method === 'code' && phone === undefined) {
          return {
            stay: true,
            errors: {
              phone:
                rawPhone === ''
                  ? 'Enter the account phone number.'
                  : 'Use the international format, for example +62812…',
            },
          }
        }
        ctx.scratch.method = method
        if (phone !== undefined) ctx.scratch.phone = phone
        await logins.sweep()
        // a fresh client for this login (a "back" to this step discards the old one)
        await logins.dispose(ctx.flowId)
        logins.open(ctx.flowId, app)
        ctx.scratch.needPassword = false
        return { next: true }
      },
    },
    {
      id: 'code',
      skip: (ctx) => ctx.scratch.method === 'qr',
      enter: async (ctx) => {
        const s = sessionOf(ctx)
        if (s === undefined) return lost
        if (s.phoneCodeHash !== undefined) return undefined
        try {
          const sent = await s.client.sendCode(String(ctx.scratch.phone))
          if ('signedIn' in sent) {
            s.user = sent.signedIn
            return { goto: 'test' }
          }
          s.phone = String(ctx.scratch.phone)
          s.phoneCodeHash = sent.phoneCodeHash
          s.codeType = sent.type
          return undefined
        } catch (error) {
          const k = classifyError(error)
          return {
            error: describeError(k),
            retryable: k.kind === 'flood' || k.kind === 'transient',
          }
        }
      },
      view: (ctx) => {
        const s = sessionOf(ctx)
        const where =
          s?.codeType === 'sms'
            ? 'by SMS'
            : s?.codeType === 'call'
              ? 'by a phone call'
              : 'to the Telegram app of the account (check its other devices)'
        return {
          type: 'form',
          title: 'Enter the login code',
          description: `Telegram sent a code ${where}. Telegram sometimes delays codes: wait a minute before asking again.`,
          fields: fieldsOf(CodeSchema),
          values: {},
          ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
          ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
          submitLabel: 'Sign in',
        }
      },
      advance: async (ctx, { action, data }) => {
        const s = sessionOf(ctx)
        if (s === undefined || s.phoneCodeHash === undefined || s.phone === undefined) return lost
        try {
          if (action === 'resend') {
            const sent = await s.client.resendCode(s.phone, s.phoneCodeHash)
            s.phoneCodeHash = sent.phoneCodeHash
            s.codeType = sent.type
            return { stay: true, message: `A new code is on its way (${sent.type}).` }
          }
          if (action !== 'submit') return { pending: true }
          const code = String(data.code ?? '').replace(/\s+/g, '')
          if (code === '') return { stay: true, errors: { code: 'Enter the code.' } }
          s.user = await s.client.signIn(s.phone, s.phoneCodeHash, code)
          return { goto: 'test' }
        } catch (error) {
          const k = classifyError(error)
          if (k.kind === 'password-needed') {
            s.needPassword = true
            ctx.scratch.needPassword = true
            return { next: true }
          }
          if (k.kind === 'code-invalid') return { stay: true, errors: { code: describeError(k) } }
          if (k.kind === 'code-expired') {
            try {
              const sent = await s.client.resendCode(s.phone, s.phoneCodeHash)
              s.phoneCodeHash = sent.phoneCodeHash
              return { stay: true, message: 'That code expired. A new one is on its way.' }
            } catch (again) {
              return { error: describeError(classifyError(again)), retryable: true }
            }
          }
          return {
            error: describeError(k),
            retryable: k.kind === 'flood' || k.kind === 'transient',
          }
        }
      },
    },
    {
      id: 'qr',
      skip: (ctx) => ctx.scratch.method !== 'qr',
      enter: (ctx) => {
        const s = sessionOf(ctx)
        if (s === undefined) return lost
        logins.startQr(ctx.flowId)
        return undefined
      },
      view: (ctx) => {
        const qr = sessionOf(ctx)?.qr
        return {
          type: 'qr',
          title: 'Scan with Telegram',
          description:
            'In the Telegram app of the account: Settings, Devices, Link Desktop Device, then scan this code. It refreshes every few seconds.',
          url: qr?.url ?? '',
          expiresAt: qr?.expiresAt || ctx.now() + 30_000,
          pollIntervalMs: qrPollMs,
        }
      },
      advance: async (ctx, { action }) => {
        if (action !== 'poll') return { pending: true }
        const s = sessionOf(ctx)
        if (s?.qr === undefined) return lost
        const qr = s.qr
        if (qr.error !== undefined) {
          const k = classifyError(qr.error)
          return { error: describeError(k), retryable: true }
        }
        if (qr.user !== undefined) return { goto: 'test' }
        if (qr.needPassword) {
          s.needPassword = true
          ctx.scratch.needPassword = true
          return { next: true }
        }
        return { pending: true }
      },
    },
    {
      id: 'password',
      skip: (ctx) => ctx.scratch.needPassword !== true,
      view: (ctx) => ({
        type: 'form',
        title: 'Two-step verification',
        description: 'This account is protected by a password. It is used once and never stored.',
        fields: fieldsOf(PasswordSchema),
        values: {},
        ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
        ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
        submitLabel: 'Continue',
      }),
      advance: async (ctx, { action, data }) => {
        if (action !== 'submit') return { pending: true }
        const s = sessionOf(ctx)
        if (s === undefined) return lost
        const password = String(typeof data.password === 'string' ? data.password : '')
        if (password === '') return { stay: true, errors: { password: 'Enter the password.' } }
        try {
          if (s.qr !== undefined) {
            s.qr.badPassword = false
            logins.submitQrPassword(ctx.flowId, password)
            const until = Date.now() + settleMs
            while (Date.now() < until) {
              if (s.qr.user !== undefined) break
              if (s.qr.error !== undefined) throw s.qr.error
              if (s.qr.badPassword) {
                return { stay: true, errors: { password: 'That password is not right.' } }
              }
              await new Promise((r) => setTimeout(r, 25))
            }
            if (s.qr.user === undefined) return { stay: true, message: 'Still checking…' }
          } else {
            s.user = await s.client.checkPassword(password)
          }
          ctx.scratch.needPassword = false
          return { goto: 'test' }
        } catch (error) {
          const k = classifyError(error)
          if (k.kind === 'password-invalid') {
            return { stay: true, errors: { password: describeError(k) } }
          }
          return {
            error: describeError(k),
            retryable: k.kind === 'flood' || k.kind === 'transient',
          }
        }
      },
    },
    {
      id: 'test',
      auto: true,
      view: () => ({ type: 'status', state: 'running', message: 'Checking the account…' }),
      advance: async (ctx) => {
        const s = sessionOf(ctx)
        if (s === undefined) return lost
        try {
          const me = s.user ?? (await s.client.getMe())
          const session = await s.client.exportSession()
          ctx.scratch.test = { accountLabel: accountLabel(me) }
          // the session is only ever in the sealed scratch and then in the credential store
          ctx.scratch.credentials = { session: { format: SESSION_FORMAT, data: session } }
          ctx.scratch.account = {
            accountId: me.id,
            ...(me.username === undefined ? {} : { username: me.username }),
            ...(me.phone === undefined ? {} : { phone: me.phone }),
          }
          return { next: true }
        } catch (error) {
          const k = classifyError(error)
          return { error: describeError(k), retryable: true }
        }
      },
    },
    {
      id: 'choose',
      enter: async (ctx) => {
        const s = sessionOf(ctx)
        if (s === undefined) return lost
        try {
          const chats = await s.client.listChats()
          ctx.scratch.dialogs = chats.slice(0, 800).map((c) => ({
            id: c.id,
            title: c.title,
            kind: c.kind,
            admin: c.admin,
            forum: c.forum,
            members: c.members,
          }))
          return undefined
        } catch (error) {
          return { error: describeError(classifyError(error)), retryable: true }
        }
      },
      view: (ctx) => {
        const dialogs = (ctx.scratch.dialogs ?? []) as TgChat[]
        return {
          type: 'choose',
          title: 'Chats to ingest',
          description:
            'Choose the groups and channels this account may read. Only these are stored; you can change the list and the history window later on the Channels page. Direct messages are not listed: people reach the agent only after they are paired.',
          options: dialogs.filter((c) => c.kind !== 'dm').map(chatOption),
          multiple: true,
          selected: Array.isArray(ctx.scratch.selected) ? (ctx.scratch.selected as string[]) : [],
          min: 0,
          ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
          ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
        }
      },
      advance: async (ctx, { action, data }) => {
        if (action !== 'submit') return { pending: true }
        const dialogs = (ctx.scratch.dialogs ?? []) as TgChat[]
        const raw = data.selected
        const selected = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String)
        const known = new Map(dialogs.map((d) => [d.id, d]))
        if (!selected.every((id) => known.has(id))) {
          return { stay: true, errors: { selected: 'Choose from the listed chats.' } }
        }
        const account = (ctx.scratch.account ?? {}) as UserConnectionSettings
        const settings: UserConnectionSettings = {
          ...account,
          chats: selected.map((id) => {
            const d = known.get(id) as TgChat
            return { id, title: d.title, kind: d.kind, admin: d.admin, forum: d.forum }
          }),
        }
        ctx.scratch.settings = settings
        ctx.scratch.selected = selected
        delete ctx.scratch.dialogs
        delete ctx.scratch.needPassword
        // the runtime opens its own client from the stored session: this one must be gone first
        // (two clients on one session end it with AUTH_KEY_DUPLICATED)
        await logins.dispose(ctx.flowId)
        return { next: true }
      },
    },
  ]

  return defineConnector({
    id: TELEGRAM_USER_CONNECTOR_ID,
    version: '1',
    name: 'Telegram account (MTProto)',
    description:
      'Reads groups and channels a bot cannot join, with history backfill and the admin log, as a user account. Ban risk: use a dedicated account and keep to the limits.',
    icon: 'telegram-logo',
    publisher: 'Telegram',
    homepage: 'https://telegram.org',
    docsUrl: TERMS_URL,
    category: 'channels',
    source: 'curated',
    scopes: ['workspace'],
    auth: { type: 'none' },
    // chat access is configured on the Channels page, not as agent tools
    capabilities: [],
    flow: steps,
  })
}
