import { apiBase, authFetch, getToken } from '#lib/api/index.js';

type SavePicker = (o: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;

/**
 * Save a snapshot file. The server streams it; where the browser can write a stream straight to a
 * chosen file (Chromium) nothing is held in memory, elsewhere it is collected into a Blob first.
 */
export async function downloadBackupFile(id: string, what: 'db' | 'files'): Promise<void> {
	const token = getToken();
	const res = await authFetch(`${apiBase.replace(/\/+$/, '')}/backups/${encodeURIComponent(id)}/${what}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {}
	});
	if (!res.ok) throw new Error(`Download failed (${res.status})`);
	const name = `${id}.${what === 'db' ? 'db' : 'zip'}`;
	const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	if (picker && res.body) {
		const handle = await picker({ suggestedName: name });
		await res.body.pipeTo(await handle.createWritable());
		return;
	}
	const url = URL.createObjectURL(await res.blob());
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Save the workspace export of the live workspace (the zip built now). With a passphrase the
 * provider keys and connection credentials travel too, encrypted in the zip; the passphrase goes in
 * the request body only.
 */
export async function downloadWorkspaceExport(passphrase?: string, includeConversations = false): Promise<void> {
	const token = getToken();
	const endpoint = `${apiBase.replace(/\/+$/, '')}/backups/export${passphrase === undefined && includeConversations ? '?conversations=true' : ''}`;
	const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
	const res = await authFetch(
		endpoint,
		passphrase === undefined ? { headers: auth } : { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase, ...(includeConversations ? { includeConversations: true } : {}) }) }
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		throw new Error(body.error?.message ?? `Download failed (${res.status})`);
	}
	const name = `team-workspace-${new Date().toISOString().slice(0, 10)}.zip`;
	const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	if (picker && res.body) {
		const handle = await picker({ suggestedName: name });
		await res.body.pipeTo(await handle.createWritable());
		return;
	}
	const url = URL.createObjectURL(await res.blob());
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Upload a workspace zip for an import; the server verifies it and answers its upload id (or the reason it was refused). */
export async function uploadWorkspaceZip(file: File): Promise<{ uploadId: string; name: string }> {
	const token = getToken();
	const res = await authFetch(`${apiBase.replace(/\/+$/, '')}/backups/imports?name=${encodeURIComponent(file.name)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/zip', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: file
	});
	const body = (await res.json().catch(() => ({}))) as { uploadId?: string; name?: string; error?: { message?: string } };
	if (!res.ok || !body.uploadId) throw new Error(body.error?.message ?? `Upload failed (${res.status})`);
	return { uploadId: body.uploadId, name: body.name ?? file.name };
}
