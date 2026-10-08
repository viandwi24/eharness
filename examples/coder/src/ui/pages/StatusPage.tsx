/** `/status`: version, environment and configuration of this session. */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderController, StatusInfo } from '../../contracts.ts'
import { color, modeLabel } from '../theme.ts'
import { Field, Loading, Page, Section } from './Page.tsx'
import { useAsync } from './useAsync.ts'

/** The body of the page. */
export function StatusBody({ s }: { s: StatusInfo }): ReactElement {
  return (
    <>
      <Section title="Session">
        <Field label="Version">
          coder {s.version} <Text dimColor>· eharness {s.eharnessVersion}</Text>
        </Field>
        <Field label="Working directory">{s.cwd}</Field>
        <Field label="Session id">{s.sessionId}</Field>
        <Field label="Provider">{s.provider}</Field>
        <Field label="Model">{s.model}</Field>
        <Field label="Thinking">{s.thinking}</Field>
        <Field label="Permission mode">{modeLabel(s.mode)}</Field>
      </Section>

      <Section title="Mounts">
        {s.mounts.map((m) => (
          <Text key={m.virtual} wrap="truncate-end">
            {m.virtual} <Text dimColor>→</Text> {m.real}{' '}
            <Text dimColor>{m.readonly ? '(read-only)' : '(read-write)'}</Text>
          </Text>
        ))}
      </Section>

      <Section title="Project">
        <Field label="Trust">
          {s.trusted ? (
            <Text color={color.ok}>trusted</Text>
          ) : (
            <Text color={color.warning}>not trusted</Text>
          )}
        </Field>
        {s.untrusted.length > 0 ? (
          <Field label="Ignored keys">{s.untrusted.join(', ')}</Field>
        ) : null}
        <Field label="Memory file">{s.memoryFile ?? '(none)'}</Field>
        <Field label="MCP servers">
          {s.mcpServers.length > 0 ? s.mcpServers.join(', ') : '(none)'}
        </Field>
        <Field label="Agents">{s.agents} defined</Field>
      </Section>

      <Section title="Settings files">
        {s.settingsFiles.map((f) => (
          <Box key={f.path}>
            <Text color={f.exists ? color.ok : color.dim}>{f.exists ? '✓' : '✗'} </Text>
            <Text dimColor={!f.exists} wrap="truncate-end">
              {f.path}
            </Text>
          </Box>
        ))}
      </Section>
    </>
  )
}

/** The `/status` page. */
export function StatusPage({
  controller,
  onClose,
  size,
}: {
  controller: CoderController
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const data = useAsync(() => controller.status())
  return (
    <Page
      title="Status"
      subtitle="this session and its configuration"
      onClose={onClose}
      size={size}
    >
      {data.status === 'loading' ? <Loading /> : null}
      {data.status === 'error' ? <Text color={color.error}>{data.message}</Text> : null}
      {data.status === 'ready' ? <StatusBody s={data.data} /> : null}
    </Page>
  )
}
