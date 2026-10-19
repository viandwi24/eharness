import { getUser } from './users.ts'

export function greet(id: number): string {
  const user = getUser(id)
  return user ? `Hello, ${user.name}` : 'Hello, stranger'
}
