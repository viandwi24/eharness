/** `/doctor`: environment checks. */
import { Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderController, DoctorCheck } from '../../contracts.ts'
import { color } from '../theme.ts'
import { Field, Loading, Page, Section } from './Page.tsx'
import { useAsync } from './useAsync.ts'

const MARK: Record<DoctorCheck['status'], { mark: string; tint: string | undefined }> = {
  ok: { mark: '✓', tint: color.ok },
  warn: { mark: '!', tint: color.warning },
  error: { mark: '✗', tint: color.error },
}

/** The doctor page. */
export function DoctorPage({
  controller,
  onClose,
  size,
}: {
  controller: CoderController
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const state = useAsync(() => controller.doctor())
  return (
    <Page title="Doctor" subtitle="environment checks" onClose={onClose} size={size}>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <Text color={color.error}>{state.message}</Text> : null}
      {state.status === 'ready' ? (
        <Section>
          {state.data.map((check) => {
            const m = MARK[check.status]
            return (
              <Field key={check.name} label={check.name} width={26}>
                <Text color={m.tint}>{m.mark}</Text> {check.detail}
              </Field>
            )
          })}
        </Section>
      ) : null}
    </Page>
  )
}
