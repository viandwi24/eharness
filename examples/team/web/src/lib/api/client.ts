import type { components, paths } from './schema';
import { type Backoff, createBackoff } from './backoff';

/** Schema types re-exported for the app. */
export type Agent = components['schemas']['Agent'];
export type AgentCreate = components['schemas']['AgentCreate'];
export type AgentPatch = components['schemas']['AgentPatch'];
export type Connector = components['schemas']['Connector'];
export type Connection = components['schemas']['Connection'];
export type ConnectionAccess = components['schemas']['ConnectionAccess'];
export type ConnectionAccessPut = components['schemas']['ConnectionAccessPut'];
export type CustomProbe = components['schemas']['CustomProbe'];
export type CustomConnectorBody = components['schemas']['CustomConnectorBody'];
export type CustomConnectorResult = components['schemas']['CustomConnectorResult'];
export type Capability = components['schemas']['Capability'];
export type CapabilityMode = components['schemas']['CapabilityMode'];
export type ConnectionChoices = components['schemas']['ConnectionChoices'];
export type AgentConnector = components['schemas']['AgentConnector'];
export type ConnectFlow = components['schemas']['ConnectFlow'];
export type FlowView = components['schemas']['FlowView'];
export type FlowResult = components['schemas']['FlowResult'];
export type PermissionMode = Agent['permissionMode'];
export type PersonaState = components['schemas']['PersonaState'];
export type PersonaVersion = components['schemas']['PersonaVersion'];
export type PersonaProposal = components['schemas']['PersonaProposal'];

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

type JsonOf<T> = T extends { content: { 'application/json': infer J } } ? J : never;
type Success<R> = JsonOf<R extends { 200: infer A } ? A : never> | JsonOf<R extends { 201: infer B } ? B : never>;

type ResponseOf<P extends keyof paths, M extends Method> = paths[P][M] extends { responses: infer R }
	? Success<R>
	: never;
type BodyOf<P extends keyof paths, M extends Method> = paths[P][M] extends {
	requestBody: { content: { 'application/json': infer B } };
}
	? B
	: never;
type PathsWith<M extends Method> = {
	[P in keyof paths]: paths[P][M] extends undefined | never | null ? never : P;
}[keyof paths];
type ParamsOf<P extends keyof paths, M extends Method> = paths[P][M] extends {
	parameters: { path?: infer X };
}
	? X
	: never;
type QueryOf<P extends keyof paths, M extends Method> = paths[P][M] extends {
	parameters: { query?: infer Q };
}
	? Q
	: never;

export type RequestOptions<P extends keyof paths, M extends Method> = {
	params?: ParamsOf<P, M>;
	query?: QueryOf<P, M>;
	body?: BodyOf<P, M>;
	signal?: AbortSignal;
};

/** The server's error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	/** The whole parsed error body (a connect-flow conflict carries the current `flow` beside `error`). */
	readonly body?: unknown;
	constructor(status: number, code: string, message: string, details?: unknown, body?: unknown) {
		super(message);
		this.body = body;
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

/** Map a failed response (status + parsed body, if any) to an ApiError. Never throws. */
export function toApiError(status: number, body: unknown): ApiError {
	const e = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
	if (e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string') {
		return new ApiError(status, e.code, e.message, e.details, body);
	}
	return new ApiError(status, status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR', `Request failed (${status})`);
}

/** Field errors from a VALIDATION_ERROR (zod issues): `{ 'name': 'message', ... }`. */
export function fieldErrors(error: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!(error instanceof ApiError) || !Array.isArray(error.details)) return out;
	for (const issue of error.details as { path?: unknown; message?: unknown }[]) {
		const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
		if (typeof issue?.message === 'string' && !(path in out)) out[path || '_'] = issue.message;
	}
	return out;
}

export type ClientOptions = {
	baseUrl: string;
	getToken?: () => string | null | undefined;
	fetch?: typeof fetch;
	/**
	 * Shared "is the server reachable" gate: network errors, HTML answers and 502/503/504 count against
	 * it. While it is down only one GET per backoff window goes out (see `backoff.ts`).
	 */
	reachability?: Backoff;
};

export function createClient(opts: ClientOptions) {
	const base = opts.baseUrl.replace(/\/+$/, '');
	const reach = opts.reachability;
	// one gate per GET endpoint: a screen that refetches an endpoint in a loop cannot hammer a failing one
	const gates = new Map<string, Backoff>();

	async function request<P extends keyof paths, M extends Method>(
		method: M,
		path: P,
		o: RequestOptions<P, M> = {}
	): Promise<ResponseOf<P, M>> {
		let url = String(path).replace(/\{(\w+)\}/g, (_, k: string) =>
			encodeURIComponent(String((o.params as Record<string, unknown> | undefined)?.[k] ?? ''))
		);
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries((o.query ?? {}) as Record<string, unknown>)) {
			if (v !== undefined && v !== null) q.set(k, String(v));
		}
		if ([...q].length) url += `?${q}`;
		const headers: Record<string, string> = { accept: 'application/json' };
		const token = opts.getToken?.();
		if (token) headers.authorization = `Bearer ${token}`;
		if (o.body !== undefined) headers['content-type'] = 'application/json';
		const gate = method === 'get' ? (gates.get(String(path)) ?? gates.set(String(path), createBackoff()).get(String(path))!) : undefined;
		if (gate && ((reach?.down && !reach.tryAcquire()) || !gate.tryAcquire())) {
			throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Trying again shortly.');
		}
		let res: Response;
		try {
			res = await (opts.fetch ?? fetch)(`${base}${url}`, {
				method: method.toUpperCase(),
				headers,
				body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
				signal: o.signal
			});
		} catch (cause) {
			if (o.signal?.aborted) throw cause;
			gate?.failure();
			reach?.failure();
			throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server');
		}
		const body: unknown = await res.json().catch(() => undefined);
		// an HTML page where JSON was expected: the API is not behind this address (a static host, a proxy error page)
		const html = (res.headers?.get?.('content-type') ?? '').includes('text/html');
		if (html || res.status === 502 || res.status === 503 || res.status === 504) {
			gate?.failure();
			reach?.failure();
			if (html) throw new ApiError(res.status || 502, 'BAD_RESPONSE', 'The server answered with a web page instead of data. Is the API address right?');
		} else if (res.status >= 500) {
			gate?.failure();
			reach?.success();
		} else {
			gate?.success();
			reach?.success();
		}
		if (!res.ok) throw toApiError(res.status, body);
		return body as ResponseOf<P, M>;
	}

	return {
		request,
		get: <P extends PathsWith<'get'>>(path: P, o?: RequestOptions<P, 'get'>) => request('get', path, o),
		post: <P extends PathsWith<'post'>>(path: P, o?: RequestOptions<P, 'post'>) => request('post', path, o),
		patch: <P extends PathsWith<'patch'>>(path: P, o?: RequestOptions<P, 'patch'>) => request('patch', path, o),
		put: <P extends PathsWith<'put'>>(path: P, o?: RequestOptions<P, 'put'>) => request('put', path, o),
		delete: <P extends PathsWith<'delete'>>(path: P, o?: RequestOptions<P, 'delete'>) => request('delete', path, o)
	};
}

export type ApiClient = ReturnType<typeof createClient>;

export type Task = components['schemas']['Task'];
export type TaskStatus = components['schemas']['TaskStatus'];
export type TaskDetail = components['schemas']['TaskDetail'];
export type Approval = components['schemas']['Approval'];
export type AgentSessions = components['schemas']['AgentSessions'];
/** What a person answers (`POST /attention/{id}/answer` without the `kind` the store adds). */
type AttentionAnswer = components['schemas']['AttentionAnswer']['answer'];
export type ApprovalBody = AttentionAnswer extends infer A ? (A extends { kind: string } ? Omit<A, 'kind'> : never) : never;

export type ModelCallSummary = components['schemas']['ModelCallSummary'];
export type ModelCallDetail = components['schemas']['ModelCallDetail'];
export type ModelCallStats = components['schemas']['ModelCallStats'];
export type ModelCallKind = ModelCallSummary['kind'];
export type ModelCallStatus = ModelCallSummary['status'];

export type Thread = components['schemas']['Thread'];
export type Notification = components['schemas']['Notification'];
export type WorkspacePause = components['schemas']['WorkspacePause'];
