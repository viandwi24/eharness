/** `CatalogCache` of `eharness/providers` in the `catalog_cache` table (same database file). */
import type { Database } from 'bun:sqlite'
import type { CatalogCache } from 'eharness/providers'

export function sqliteCatalogCache(sqlite: Database): CatalogCache {
  return {
    async get(key) {
      const row = sqlite
        .query<{ data: string; fetched_at: number }, [string]>(
          'SELECT data, fetched_at FROM catalog_cache WHERE key = ?',
        )
        .get(key)
      if (row === null) return undefined
      try {
        return { data: JSON.parse(row.data), fetchedAt: row.fetched_at }
      } catch {
        return undefined
      }
    },
    async set(key, entry) {
      sqlite
        .query(
          `INSERT INTO catalog_cache (key, data, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
        )
        .run(key, JSON.stringify(entry.data), entry.fetchedAt)
    },
  }
}
