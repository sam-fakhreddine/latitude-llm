import { database, SafeUser, users } from '@latitude-data/core'
import { eq } from 'drizzle-orm'

export class UserNotFoundError extends Error {
  constructor() {
    super('User not found')
  }
}

export type SessionData = {
  user: SafeUser
  workspace: { id: number; name: string }
}

export function getUser(id?: string) {
  return database.query.users.findFirst({
    where: eq(users.id, id ?? ''),
  })
}
