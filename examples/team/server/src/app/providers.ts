/** Provider profile use cases (the HTTP routes call these; the port does the work). */
import { inUse } from '../domain/errors.ts'
import type { ProfileCreate, ProfilePatch } from '../domain/providers.ts'
import type { Deps } from './ports.ts'

export const describeProviders = (deps: Deps) => deps.providers.describe()
export const createProfile = (deps: Deps, input: ProfileCreate) => deps.providers.create(input)
export const updateProfile = (deps: Deps, id: string, patch: ProfilePatch) =>
  deps.providers.update(id, patch)
export const testProfile = (deps: Deps, id: string) => deps.providers.test(id)
export const listProfileModels = (deps: Deps, id: string, refresh: boolean, all = false) =>
  deps.providers.models(id, { refresh, all })

/** Delete a profile unless an agent or the workspace default still points at it. */
export async function deleteProfile(deps: Deps, id: string): Promise<void> {
  const agents = deps.agents.list().filter((a) => a.modelProfile === id)
  const isDefault = deps.settings.get().defaultProfile === id
  if (agents.length > 0 || isDefault) {
    const where = [
      ...agents.map((a) => `agent ${a.slug}`),
      ...(isDefault ? ['the workspace default'] : []),
    ]
    throw inUse('profile', id, where, 'PROFILE_IN_USE', {
      agents: agents.map((a) => a.slug),
      workspaceDefault: isDefault,
    })
  }
  await deps.providers.remove(id)
}
