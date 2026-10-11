/**
 * The stable instance id of this coder process (spec 05 §9.2): a coder that crashed leaves its turn
 * `activeTurn` in the session file; the next coder of the project owns it and recovers it at once
 * instead of answering "busy" for two minutes. A pid file keeps two coders that run at the same
 * time apart: the second one gets a random id (the stale timeout applies to a foreign turn).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STABLE_ID = 'coder'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface InstanceClaim {
  /** `recovery.instanceId` for every agent of this process; undefined = random (another coder runs). */
  instanceId: string | undefined
  release(): Promise<void>
}

/** Claim the project's stable instance id when no other coder process is alive. */
export async function claimInstance(projectDataDir: string): Promise<InstanceClaim> {
  const file = join(projectDataDir, 'coder.pid')
  try {
    await mkdir(projectDataDir, { recursive: true })
    const other = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
    if (Number.isFinite(other) && other !== process.pid && alive(other)) {
      return { instanceId: undefined, release: async () => {} }
    }
    await writeFile(file, String(process.pid))
  } catch {
    return { instanceId: undefined, release: async () => {} }
  }
  return {
    instanceId: STABLE_ID,
    release: async () => {
      const mine = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
      if (mine === process.pid) await rm(file, { force: true })
    },
  }
}
