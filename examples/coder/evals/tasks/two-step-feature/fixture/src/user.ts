export interface User {
  name: string
}

export function describeUser(user: User): string {
  return user.name
}
