/** `/cost`: token usage and estimated cost of the session. */
import { Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderController, UsageSummary } from '../../contracts.ts'
import { color } from '../theme.ts'
import { fmtDuration, fmtTokens, fmtUsd, shortModel } from './format.ts'
import { Field, Loading, Page, Section } from './Page.tsx'
import { useAsync } from './useAsync.ts'

function thousands(n: number): string {
  return n.toLocaleString('en-US')
}

/** The body of the page. */
export function CostBody({ u, model }: { u: UsageSummary; model: string }): ReactElement {
  const perTurn = u.costUsd !== undefined && u.turns > 0 ? u.costUsd / u.turns : undefined
  return (
    <>
      <Section title="Cost">
        <Field label="Estimated cost" width={22}>
          {u.costUsd === undefined ? (
            <Text dimColor>not priced for {shortModel(model)}</Text>
          ) : (
            <Text bold>{fmtUsd(u.costUsd)}</Text>
          )}
        </Field>
        <Field label="Cost per turn" width={22}>
          {perTurn === undefined ? <Text dimColor>n/a</Text> : fmtUsd(perTurn)}
        </Field>
      </Section>
      <Section title="Tokens">
        <Field label="Input" width={22}>
          {thousands(u.inputTokens)} <Text dimColor>({fmtTokens(u.inputTokens)})</Text>
        </Field>
        <Field label="Output" width={22}>
          {thousands(u.outputTokens)} <Text dimColor>({fmtTokens(u.outputTokens)})</Text>
        </Field>
        <Field label="Cached input" width={22}>
          {u.cachedInputTokens === undefined ? (
            <Text dimColor>n/a</Text>
          ) : (
            <>
              {thousands(u.cachedInputTokens)}{' '}
              <Text dimColor>({fmtTokens(u.cachedInputTokens)})</Text>
            </>
          )}
        </Field>
      </Section>
      <Section title="Time">
        <Field label="Turns" width={22}>
          {u.turns}
        </Field>
        <Field label="Wall time" width={22}>
          {fmtDuration(u.durationMs)}
        </Field>
      </Section>
    </>
  )
}

/** The `/cost` page. */
export function CostPage({
  controller,
  onClose,
  size,
}: {
  controller: CoderController
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const data = useAsync(() => controller.usage())
  return (
    <Page title="Cost" subtitle="usage of this session" onClose={onClose} size={size}>
      {data.status === 'loading' ? <Loading /> : null}
      {data.status === 'error' ? <Text color={color.error}>{data.message}</Text> : null}
      {data.status === 'ready' ? <CostBody u={data.data} model={controller.model} /> : null}
    </Page>
  )
}
