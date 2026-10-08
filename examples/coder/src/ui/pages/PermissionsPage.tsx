/** `/permissions`: the mode and the rules by kind. Rules are edited with the slash syntax. */
import { Text } from 'ink'
import type { ReactElement } from 'react'
import type { PermissionEngine, PermissionRules } from '../../contracts.ts'
import { color, modeColor, modeLabel } from '../theme.ts'
import { Field, Page, Section } from './Page.tsx'

const KINDS: Array<{ kind: keyof PermissionRules; note: string; tint: string | undefined }> = [
  { kind: 'allow', note: 'run without asking', tint: color.ok },
  { kind: 'ask', note: 'always ask first', tint: color.warning },
  { kind: 'deny', note: 'never run', tint: color.error },
]

/** The permissions page. */
export function PermissionsPage({
  engine,
  onClose,
  size,
}: {
  engine: PermissionEngine
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const rules = engine.rules()
  const inactive = engine.inactiveTools()
  return (
    <Page title="Permissions" subtitle="mode and rules" onClose={onClose} size={size}>
      <Section title="Mode">
        <Field label="Current mode">
          <Text color={modeColor(engine.mode)} bold>
            {modeLabel(engine.mode)}
          </Text>
        </Field>
        <Field label="Inactive tools">{inactive.length > 0 ? inactive.join(', ') : '(none)'}</Field>
      </Section>
      {KINDS.map(({ kind, note, tint }) => (
        <Section key={kind} title={`${kind} (${rules[kind].length}) — ${note}`}>
          {rules[kind].length === 0 ? <Text dimColor>(none)</Text> : null}
          {rules[kind].map((rule) => (
            <Text key={rule} wrap="truncate-end">
              <Text color={tint}>•</Text> {rule}
            </Text>
          ))}
        </Section>
      ))}
      <Section title="Edit">
        <Text dimColor>/permissions allow|ask|deny {'<rule>'} [--project]</Text>
        <Text dimColor>/permissions remove allow|ask|deny {'<rule>'}</Text>
        <Text dimColor>/permissions mode {'<mode>'} [--yes]</Text>
      </Section>
    </Page>
  )
}
