export const refreshLeaseGuard = `EXISTS(
  SELECT 1 FROM public_precompute_state
  WHERE id=1
    AND dirty=1
    AND generation=?
    AND refresh_token=?
    AND refresh_lease_until>unixepoch()
)`;

/**
 * Insert rows from `selectSql`, updating an existing key only when a
 * non-key column differs. Key-only tables use DO NOTHING. `selectSql` must
 * contain a WHERE clause so SQLite can parse the trailing ON CONFLICT.
 */
export const projectionUpsert = ({
  table,
  columns,
  keys,
  selectSql,
  preserveUnchangedPinyin = false,
}: {
  table: string;
  columns: readonly string[];
  keys: readonly string[];
  selectSql: string;
  preserveUnchangedPinyin?: boolean;
}) => {
  const keySet = new Set(keys);
  const assignments = columns
    .filter((column) => !keySet.has(column))
    .map((column) => {
      if (preserveUnchangedPinyin && column === "pinyin_text") {
        return `pinyin_text=CASE
          WHEN excluded.match_text=${table}.match_text THEN excluded.pinyin_text
          WHEN excluded.pinyin_text<>'' THEN excluded.pinyin_text
          ELSE ${table}.pinyin_text
        END`;
      }
      return `${column}=excluded.${column}`;
    })
    .join(",");
  if (!assignments) {
    return `INSERT INTO ${table}(${columns.join(",")})
    ${selectSql}
    ON CONFLICT(${keys.join(",")}) DO NOTHING`;
  }
  const differences = columns
    .filter((column) => !keySet.has(column))
    .map((column) => {
      if (preserveUnchangedPinyin && column === "pinyin_text") {
        return `(
          (excluded.match_text=${table}.match_text AND ${table}.pinyin_text IS NOT excluded.pinyin_text)
          OR (
            excluded.match_text IS NOT ${table}.match_text
            AND excluded.pinyin_text<>''
            AND ${table}.pinyin_text IS NOT excluded.pinyin_text
          )
        )`;
      }
      return `${table}.${column} IS NOT excluded.${column}`;
    })
    .join(" OR ");
  return `INSERT INTO ${table}(${columns.join(",")})
    ${selectSql}
    ON CONFLICT(${keys.join(",")}) DO UPDATE SET
      ${assignments}
    WHERE ${differences}`;
};

export const staleKeyDelete = (
  table: string,
  keys: readonly string[],
  freshSql: string,
) => `DELETE FROM ${table}
  WHERE NOT EXISTS (
    SELECT 1 FROM (${freshSql}) fresh
    WHERE ${keys.map((key) => `fresh.${key}=${table}.${key}`).join(" AND ")}
  )
  AND ${refreshLeaseGuard}`;

export const bindLease = (
  db: D1Database,
  sql: string,
  generation: number,
  token: string,
  leading: readonly unknown[] = [],
) => db.prepare(sql).bind(...leading, generation, token);
