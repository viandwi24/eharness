import { getUser } from './users.ts'

export function label(id: number): string {
  return getUser(id)?.name ?? 'unknown'
}
