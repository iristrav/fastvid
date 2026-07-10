/**
 * schemaAuditor.ts
 *
 * Compares the live MySQL database schema against every table/column/index/FK
 * declared in drizzle/schema.ts. Called at startup after migrations run.
 * Any mismatch is collected into a typed diff list; the caller decides whether
 * to abort (default: yes — never serve traffic with a wrong schema).
 *
 * Checks performed per table:
 *   columns     — existence, DATA_TYPE, VARCHAR length, enum values
 *   nullability — NOT NULL vs IS_NULLABLE
 *   defaults    — scalar defaults; CURRENT_TIMESTAMP for defaultNow()
 *   auto_incr   — EXTRA contains "auto_increment"
 *   indexes     — all schema-declared indexes exist with correct columns
 *   unique       — inline .unique() and uniqueIndex() are present and unique
 *   foreign keys — referenced table + column match
 *
 * Things intentionally NOT flagged as errors:
 *   - Extra columns/indexes in the DB not in the schema (harmless leftovers)
 *   - ON UPDATE CURRENT_TIMESTAMP (MySQL adds this automatically for some
 *     timestamp columns; the schema declares it via onUpdateNow() but checking
 *     it would require parsing EXTRA which varies across MySQL versions)
 *   - Index names generated automatically by MySQL for FK constraints
 */

import { sql, getTableName, getTableColumns, is, SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/mysql-core";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import fs from "fs";
import path from "path";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SchemaDiff {
  /** Table where the diff was found. */
  table: string;
  /** Column name if the diff is column-level; undefined for table-level or index diffs. */
  column?: string;
  /** Aspect that differs: "column_missing", "type", "nullable", "default", "length",
   *  "enum_values", "auto_increment", "index_missing", "index_columns",
   *  "unique_missing", "fk_missing", "fk_references", "table_missing" */
  aspect: string;
  /** What the Drizzle schema declares. */
  expected: string;
  /** What the live DB has (or "absent"). */
  actual: string;
  /** Best-guess migration file responsible (without .sql extension). */
  migration?: string;
}

// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface DbColumn {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;      // "int", "varchar", "text", "json", "enum", "timestamp", "longtext"
  COLUMN_TYPE: string;    // full: "varchar(128)", "enum('a','b')", "int"
  CHARACTER_MAXIMUM_LENGTH: number | null;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_DEFAULT: string | null;
  EXTRA: string;          // "auto_increment", "DEFAULT_GENERATED", etc.
}

interface DbIndex {
  TABLE_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
  NON_UNIQUE: number;     // 0 = unique, 1 = not unique
  SEQ_IN_INDEX: number;
}

interface DbFk {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

// ─── Type mapping: Drizzle columnType → expected MySQL DATA_TYPE ──────────────

const DRIZZLE_TYPE_TO_MYSQL: Record<string, string> = {
  MySqlInt:        "int",
  MySqlVarChar:    "varchar",
  MySqlText:       "text",      // textType field distinguishes text vs longtext
  MySqlJson:       "json",
  MySqlEnumColumn: "enum",
  MySqlTimestamp:  "timestamp",
  MySqlBoolean:    "tinyint",
  MySqlTinyInt:    "tinyint",
  MySqlSmallInt:   "smallint",
  MySqlMediumInt:  "mediumint",
  MySqlBigInt:     "bigint",
  MySqlFloat:      "float",
  MySqlDouble:     "double",
  MySqlDecimal:    "decimal",
  MySqlDate:       "date",
  MySqlDateTime:   "datetime",
  MySqlTime:       "time",
  MySqlYear:       "year",
  MySqlBinary:     "binary",
  MySqlVarBinary:  "varbinary",
  MySqlChar:       "char",
  MySqlTinyText:   "tinytext",
  MySqlMediumText: "mediumtext",
  MySqlBlob:       "blob",
  MySqlMediumBlob: "mediumblob",
  MySqlLongBlob:   "longblob",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the expected MySQL DATA_TYPE for a Drizzle column. */
function expectedDataType(col: MySqlColumn): string {
  const ct = (col as unknown as { columnType: string }).columnType;
  if (ct === "MySqlText") {
    const tt = (col as unknown as { config: { textType?: string } }).config?.textType;
    return tt === "longtext" ? "longtext"
      : tt === "mediumtext" ? "mediumtext"
      : tt === "tinytext"   ? "tinytext"
      : "text";
  }
  return DRIZZLE_TYPE_TO_MYSQL[ct] ?? ct;
}

/** Returns the expected VARCHAR/CHAR length from a Drizzle column, or null if N/A. */
function expectedLength(col: MySqlColumn): number | null {
  const cfg = (col as unknown as { config: { length?: number } }).config;
  return cfg?.length ?? null;
}

/** Returns the expected enum values sorted, or null if N/A. */
function expectedEnumValues(col: MySqlColumn): string[] | null {
  const cfg = (col as unknown as { config: { enumValues?: string[] } }).config;
  return cfg?.enumValues ? [...cfg.enumValues].sort() : null;
}

/** Parses MySQL COLUMN_TYPE "enum('a','b','c')" into sorted string[]. */
function parseDbEnumValues(columnType: string): string[] {
  const m = columnType.match(/^enum\((.+)\)$/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, ""))
    .sort();
}

/** True if the Drizzle column uses a SQL expression as its default (e.g. now()). */
function isSqlDefault(col: MySqlColumn): boolean {
  const d = (col as unknown as { config: { default?: unknown } }).config?.default;
  return d !== undefined && d !== null && typeof d === "object" && is(d as object, SQL);
}

/** Returns the expected scalar default as a string, or null if N/A / SQL expression. */
function expectedScalarDefault(col: MySqlColumn): string | null {
  if (isSqlDefault(col)) return null; // SQL expression — handled separately
  const cfg = (col as unknown as { config: { hasDefault: boolean; default?: unknown } }).config;
  if (!cfg.hasDefault) return null;
  if (cfg.default === null || cfg.default === undefined) return null;
  return String(cfg.default);
}

/**
 * True if the column uses defaultNow() — meaning the DB should show
 * COLUMN_DEFAULT = 'CURRENT_TIMESTAMP'.
 */
function isDefaultNow(col: MySqlColumn): boolean {
  const cfg = (col as unknown as { config: { default?: unknown } }).config;
  if (!isSqlDefault(col)) return false;
  const chunks = (cfg.default as unknown as { queryChunks?: { value?: unknown[] }[] })?.queryChunks;
  return Array.isArray(chunks) && chunks.some((c) => String(c.value?.[0]).includes("now()"));
}

// ─── Migration finder ─────────────────────────────────────────────────────────

/**
 * Scan migration SQL files to find which one is most likely responsible for a
 * given table or column. Returns the migration tag (e.g. "0032_clip_annotation")
 * or undefined if not found.
 */
function findResponsibleMigration(
  migrationsFolder: string,
  tableName: string,
  columnName?: string,
  indexName?: string
): string | undefined {
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8")
    ) as { entries: { tag: string }[] };

    // Search migrations in reverse order — the most recent one wins.
    const entries = [...journal.entries].reverse();
    for (const entry of entries) {
      const filePath = path.join(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(filePath)) continue;
      const sql = fs.readFileSync(filePath, "utf-8").toLowerCase();
      const needle = indexName
        ? indexName.toLowerCase()
        : columnName
          ? columnName.toLowerCase()
          : tableName.toLowerCase();
      if (sql.includes(needle)) return entry.tag;
    }
  } catch {
    // Best-effort — don't throw if migration scanning fails.
  }
  return undefined;
}

// ─── Main auditor ─────────────────────────────────────────────────────────────

export async function auditSchema(
  db: Awaited<ReturnType<typeof import("./db").getDb>>,
  migrationsFolder?: string
): Promise<SchemaDiff[]> {
  if (!db) return [];

  const diffs: SchemaDiff[] = [];
  const migFolder = migrationsFolder ?? "";

  // ── 1. Load live DB metadata in three queries ──────────────────────────────

  const [colRows] = await db.execute<DbColumn>(
    sql`SELECT
          TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
          CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );

  const [idxRows] = await db.execute<DbIndex>(
    sql`SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
  );

  const [fkRows] = await db.execute<DbFk>(
    sql`SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
               kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
          ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
         AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
        ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`
  );

  // Cast raw rows (mysql2 returns them typed as ResultSetHeader at the TS level
  // but they are plain objects at runtime).
  const dbColumns   = colRows as unknown as DbColumn[];
  const dbIndexRows = idxRows as unknown as DbIndex[];
  const dbFkRows    = fkRows  as unknown as DbFk[];

  // Build lookup structures.
  const dbColMap = new Map<string, Map<string, DbColumn>>();
  for (const row of dbColumns) {
    if (!dbColMap.has(row.TABLE_NAME)) dbColMap.set(row.TABLE_NAME, new Map());
    dbColMap.get(row.TABLE_NAME)!.set(row.COLUMN_NAME, row);
  }

  // idxMap: tableName → indexName → { nonUnique, columns (ordered) }
  const dbIdxMap = new Map<string, Map<string, { nonUnique: number; columns: string[] }>>();
  for (const row of dbIndexRows) {
    if (!dbIdxMap.has(row.TABLE_NAME)) dbIdxMap.set(row.TABLE_NAME, new Map());
    const tableIdxs = dbIdxMap.get(row.TABLE_NAME)!;
    if (!tableIdxs.has(row.INDEX_NAME)) tableIdxs.set(row.INDEX_NAME, { nonUnique: row.NON_UNIQUE, columns: [] });
    tableIdxs.get(row.INDEX_NAME)!.columns.push(row.COLUMN_NAME);
  }

  // fkMap: tableName → constraintName → { column, refTable, refColumn }[]
  const dbFkMap = new Map<string, { constraintName: string; column: string; refTable: string; refColumn: string }[]>();
  for (const row of dbFkRows) {
    if (!dbFkMap.has(row.TABLE_NAME)) dbFkMap.set(row.TABLE_NAME, []);
    dbFkMap.get(row.TABLE_NAME)!.push({
      constraintName: row.CONSTRAINT_NAME,
      column: row.COLUMN_NAME,
      refTable: row.REFERENCED_TABLE_NAME,
      refColumn: row.REFERENCED_COLUMN_NAME,
    });
  }

  // ── 2. Load Drizzle schema ─────────────────────────────────────────────────

  const schema = await import("../drizzle/schema");

  // Collect all table objects exported from schema.ts.
  const tables: Parameters<typeof getTableConfig>[0][] = [];
  for (const exported of Object.values(schema)) {
    if (typeof exported !== "object" || exported === null) continue;
    try {
      getTableColumns(exported as Parameters<typeof getTableColumns>[0]);
      tables.push(exported as Parameters<typeof getTableConfig>[0]);
    } catch {
      // Not a table object.
    }
  }

  // ── 3. Per-table audit ─────────────────────────────────────────────────────

  for (const table of tables) {
    const tableName = getTableName(table);
    const cfg = getTableConfig(table);
    const dbCols = dbColMap.get(tableName);

    if (!dbCols) {
      diffs.push({
        table: tableName,
        aspect: "table_missing",
        expected: "table exists",
        actual: "absent",
        migration: findResponsibleMigration(migFolder, tableName),
      });
      continue; // can't check columns if table is absent
    }

    // 3a. Columns ─────────────────────────────────────────────────────────────
    for (const schCol of cfg.columns) {
      const colName = schCol.name;
      const dbCol = dbCols.get(colName);

      if (!dbCol) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "column_missing",
          expected: "column exists",
          actual: "absent",
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
        continue;
      }

      const expType = expectedDataType(schCol);
      if (dbCol.DATA_TYPE !== expType) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "type",
          expected: expType,
          actual: dbCol.DATA_TYPE,
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
      }

      // VARCHAR / CHAR length
      const expLen = expectedLength(schCol);
      if (expLen !== null && dbCol.CHARACTER_MAXIMUM_LENGTH !== null && dbCol.CHARACTER_MAXIMUM_LENGTH !== expLen) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "length",
          expected: String(expLen),
          actual: String(dbCol.CHARACTER_MAXIMUM_LENGTH),
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
      }

      // Enum values
      if (expType === "enum") {
        const expValues = expectedEnumValues(schCol);
        const actValues = parseDbEnumValues(dbCol.COLUMN_TYPE);
        if (expValues && JSON.stringify(expValues) !== JSON.stringify(actValues)) {
          diffs.push({
            table: tableName, column: colName,
            aspect: "enum_values",
            expected: expValues.join(", "),
            actual: actValues.join(", "),
            migration: findResponsibleMigration(migFolder, tableName, colName),
          });
        }
      }

      // Nullability
      const expNotNull = (schCol as unknown as { notNull: boolean }).notNull === true;
      const actNullable = dbCol.IS_NULLABLE === "YES";
      if (expNotNull && actNullable) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "nullable",
          expected: "NOT NULL",
          actual: "NULL",
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
      }

      // Scalar default
      const expDefault = expectedScalarDefault(schCol);
      if (expDefault !== null) {
        // MySQL stores integer defaults as strings (e.g. "0"), so normalise to string.
        const actDefault = dbCol.COLUMN_DEFAULT;
        if (actDefault === null || String(actDefault) !== expDefault) {
          diffs.push({
            table: tableName, column: colName,
            aspect: "default",
            expected: expDefault,
            actual: actDefault === null ? "NULL" : String(actDefault),
            migration: findResponsibleMigration(migFolder, tableName, colName),
          });
        }
      }

      // defaultNow() → expect CURRENT_TIMESTAMP or now() in COLUMN_DEFAULT
      // MySQL 8 stores this as now() while older versions use CURRENT_TIMESTAMP; both are valid.
      if (isDefaultNow(schCol)) {
        const actDefault = dbCol.COLUMN_DEFAULT ?? "";
        const upper = actDefault.toUpperCase();
        if (!upper.includes("CURRENT_TIMESTAMP") && !upper.includes("NOW()")) {
          diffs.push({
            table: tableName, column: colName,
            aspect: "default",
            expected: "CURRENT_TIMESTAMP",
            actual: actDefault || "NULL",
            migration: findResponsibleMigration(migFolder, tableName, colName),
          });
        }
      }

      // Auto-increment
      const expAutoInc = (schCol as unknown as { autoIncrement?: boolean }).autoIncrement === true;
      const actAutoInc = dbCol.EXTRA.toLowerCase().includes("auto_increment");
      if (expAutoInc && !actAutoInc) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "auto_increment",
          expected: "AUTO_INCREMENT",
          actual: dbCol.EXTRA || "none",
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
      }
    }

    // 3b. Indexes (schema-declared named indexes) ──────────────────────────────
    const dbTableIdxs = dbIdxMap.get(tableName) ?? new Map<string, { nonUnique: number; columns: string[] }>();

    for (const idx of cfg.indexes) {
      const idxName: string = (idx as unknown as { config: { name: string } }).config?.name;
      const idxCols: string[] = (idx as unknown as { config: { columns: MySqlColumn[] } }).config?.columns?.map(
        (c: MySqlColumn) => c.name
      ) ?? [];
      const isUniq: boolean = (idx as unknown as { config: { unique?: boolean } }).config?.unique === true;

      if (!idxName) continue;

      const dbIdx = dbTableIdxs.get(idxName);
      if (!dbIdx) {
        diffs.push({
          table: tableName,
          aspect: isUniq ? "unique_missing" : "index_missing",
          expected: `index '${idxName}' on (${idxCols.join(", ")})`,
          actual: "absent",
          migration: findResponsibleMigration(migFolder, tableName, undefined, idxName),
        });
        continue;
      }

      // Column list must match in order.
      if (JSON.stringify(dbIdx.columns) !== JSON.stringify(idxCols)) {
        diffs.push({
          table: tableName,
          aspect: "index_columns",
          expected: `${idxName}: (${idxCols.join(", ")})`,
          actual: `${idxName}: (${dbIdx.columns.join(", ")})`,
          migration: findResponsibleMigration(migFolder, tableName, undefined, idxName),
        });
      }

      // Uniqueness must match.
      if (isUniq && dbIdx.nonUnique !== 0) {
        diffs.push({
          table: tableName,
          aspect: "unique_missing",
          expected: `index '${idxName}' is UNIQUE`,
          actual: "index exists but is NOT UNIQUE",
          migration: findResponsibleMigration(migFolder, tableName, undefined, idxName),
        });
      }
    }

    // 3c. Inline unique columns (.unique() on a column) ──────────────────────
    for (const schCol of cfg.columns) {
      if (!(schCol as unknown as { isUnique: boolean }).isUnique) continue;
      const colName = schCol.name;
      // MySQL creates a unique index named after the column's uniqueName.
      // Either that or PRIMARY key covers it. Check any unique index covers this column.
      const coveredByUnique = Array.from(dbTableIdxs.values()).some(
        (idx) => idx.nonUnique === 0 && idx.columns.includes(colName)
      );
      if (!coveredByUnique) {
        diffs.push({
          table: tableName, column: colName,
          aspect: "unique_missing",
          expected: `UNIQUE constraint on '${colName}'`,
          actual: "no unique index found",
          migration: findResponsibleMigration(migFolder, tableName, colName),
        });
      }
    }

    // 3d. Foreign keys ─────────────────────────────────────────────────────────
    const dbFks = dbFkMap.get(tableName) ?? [];

    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const ownCols: string[]    = ref.columns.map((c: MySqlColumn) => c.name);
      const refTable: string     = getTableName(ref.foreignTable);
      const refCols: string[]    = ref.foreignColumns.map((c: MySqlColumn) => c.name);

      // Find a DB FK that matches own column(s) → ref table + ref column(s).
      const match = dbFks.find(
        (dbFk) => ownCols.includes(dbFk.column) && dbFk.refTable === refTable && refCols.includes(dbFk.refColumn)
      );

      if (!match) {
        diffs.push({
          table: tableName,
          aspect: "fk_missing",
          expected: `FK (${ownCols.join(", ")}) → ${refTable}(${refCols.join(", ")})`,
          actual: "no matching FK found",
          migration: findResponsibleMigration(migFolder, tableName, ownCols[0]),
        });
      }
    }
  }

  return diffs;
}
