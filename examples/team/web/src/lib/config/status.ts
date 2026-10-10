// Shared vocabulary of provider profiles and connections: one status set, one badge mapping, one
// test-result shape. Pure, so both UIs (Settings > Providers, Connectors) and their tests use it.

export type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' | 'brand' | 'info';
export type ConfigStatus = 'connected' | 'off' | 'needs-auth' | 'error' | 'env' | 'custom' | 'default' | 'disabled' | 'included';

export const STATUS_BADGE: Record<ConfigStatus, { label: string; variant: BadgeVariant }> = {
	connected: { label: 'Connected', variant: 'success' },
	off: { label: 'Off', variant: 'secondary' },
	'needs-auth': { label: 'Reconnect needed', variant: 'warning' },
	error: { label: 'Error', variant: 'destructive' },
	env: { label: 'Env', variant: 'secondary' },
	custom: { label: 'Custom', variant: 'outline' },
	default: { label: 'Default', variant: 'brand' },
	disabled: { label: 'Disabled', variant: 'warning' },
	included: { label: 'Included', variant: 'info' }
};

/** The status of a connection row. */
export function connectionStatus(c: { status?: string; enabled: boolean }): ConfigStatus {
	if (!c.enabled || c.status === 'disabled') return 'off';
	if (c.status === 'needs-auth') return 'needs-auth';
	if (c.status === 'error') return 'error';
	return 'connected';
}

/** The badges of a provider profile, in display order. */
export function profileStatuses(p: { source: string; enabled: boolean; isDefault?: boolean }): ConfigStatus[] {
	return [p.source === 'env' ? 'env' : 'custom', ...(p.isDefault ? (['default'] as const) : []), ...(p.enabled ? [] : (['disabled'] as const))];
}

/** What a "Test" produced, for providers and connections alike. */
export type TestOutcome = { ok: boolean; message?: string; latencyMs?: number; tools?: number; busy?: boolean };

/** One line for a test outcome: "Connected: message (120 ms · 12 tools)" or the failure reason. */
export function testSummary(r: TestOutcome): string {
	if (!r.ok) return r.message ?? 'Connection failed';
	const extra = [r.latencyMs ? `${r.latencyMs} ms` : '', r.tools !== undefined ? `${r.tools} tools` : ''].filter(Boolean).join(' · ');
	return `Connected${r.message ? `: ${r.message}` : ''}${extra ? ` (${extra})` : ''}`;
}

/** Run a test call and fold a thrown error into a failed outcome (the UI never throws on a test). */
export async function runTest(call: () => Promise<TestOutcome>): Promise<TestOutcome> {
	try {
		return await call();
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
	}
}
