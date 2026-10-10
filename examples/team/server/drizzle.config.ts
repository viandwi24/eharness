import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` writes SQL migrations to ./drizzle from the schema; they are applied at
// boot by `migrate()` (src/infra/db/client.ts). Never hand-write them.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infra/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.TEAM_DB ?? './data/team.db' },
})
