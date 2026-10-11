import { api } from '../api/index';
import type { ApproveBody } from './model';

/**
 * Approve or reject a decision. The answer bodies are optional on the server (a bare POST works),
 * which the generated client types as no body at all: hence the cast, in this one place.
 */
export function decide(id: string, kind: 'approve', body: ApproveBody): Promise<unknown>;
export function decide(id: string, kind: 'reject', body: { note?: string }): Promise<unknown>;
export function decide(id: string, kind: 'approve' | 'reject', body: ApproveBody | { note?: string }): Promise<unknown> {
	return api.post(`/decisions/{id}/${kind}`, { params: { id }, body: body as never });
}
