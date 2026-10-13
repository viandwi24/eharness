/**
 * Per-session Linux users ("uid isolation"). When the server runs as root in a container where
 * bubblewrap cannot start, every session gets its own uid from a pool; commands drop to it with
 * `setpriv`, and the session directory is mode 0700 and owned by it. A script then cannot read
 * another session's directory nor the server's environment (`/proc/<pid>/environ` needs the
 * same uid). The functions here are pure (no I/O) so they are unit-tested; server.ts does the I/O.
 */

export interface UidPool {
  /** A free uid, or `null` when the pool is exhausted. */
  acquire(): number | null
  release(uid: number): void
  inUse(): number
}

/** A pool of `size` uids starting at `base`. Released uids are handed out again (lowest first). */
export function createUidPool(base: number, size: number): UidPool {
  if (!Number.isInteger(base) || base < 1000) throw new Error('uid base must be an integer >= 1000')
  if (!Number.isInteger(size) || size < 1) throw new Error('uid pool size must be >= 1')
  const used = new Set<number>()
  return {
    acquire() {
      for (let uid = base; uid < base + size; uid++) {
        if (!used.has(uid)) {
          used.add(uid)
          return uid
        }
      }
      return null
    },
    release(uid) {
      used.delete(uid)
    },
    inUse: () => used.size,
  }
}

/** `setpriv` arguments that drop to `uid:uid` with no supplementary groups and no way back. */
export function setprivArgs(uid: number): string[] {
  return [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--no-new-privs', '--']
}

/** Environment variable carrying the session uid to the wrapper (set by the server, never by clients). */
export const UID_ENV = 'EH_SANDBOX_UID'

/**
 * Text of the shell wrapper installed in the image (as `.../bash`, so the ulimit block size
 * stays right): `<wrapper> -c <command>` runs `<command>` in `shell` as the uid in
 * {@link UID_ENV}. It lives outside `/tmp`, which containers mount `noexec`.
 */
export function wrapperScript(shell = '/bin/bash', setpriv = 'setpriv'): string {
  return `#!/bin/sh
uid="$${UID_ENV}"
case "$uid" in ''|*[!0-9]*) echo "${UID_ENV} missing" >&2; exit 126;; esac
[ "$uid" -ge 1000 ] || { echo "refusing uid $uid" >&2; exit 126; }
unset ${UID_ENV}
exec ${setpriv} --reuid="$uid" --regid="$uid" --clear-groups --no-new-privs -- ${shell} "$@"
`
}

/** argv that kills every process of `uid` (runs as that uid: `kill -9 -1` reaches only its own). */
export function killUidArgv(uid: number, setpriv = 'setpriv'): string[] {
  return [setpriv, ...setprivArgs(uid), '/bin/sh', '-c', 'kill -9 -1']
}

export interface IsolationInfo {
  isolated: boolean
  label: string
}

/** What `/v1/info` reports: honest about whether sessions are separated from each other. */
export function isolationInfo(mode: { uids: boolean; osSandbox: boolean }): IsolationInfo {
  if (mode.uids) return { isolated: true, label: 'sandbox-server container, one user per session' }
  if (mode.osSandbox)
    return { isolated: true, label: 'sandbox-server, OS sandbox (shared user, no network)' }
  return { isolated: false, label: 'sandbox-server, shared user (not isolated between sessions)' }
}

/** Uid isolation needs root on Linux. */
export function canIsolateUids(platform: string, uid: number | undefined): boolean {
  return platform === 'linux' && uid === 0
}

export const SHARED_USER_WARNING =
  'uid isolation off: sessions share one user (run the container as root so the server can drop privileges per session)'
