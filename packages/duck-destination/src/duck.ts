/**
 * Implementación única del `Destination` que cubre los dos backends:
 *  - DuckDB local (file o `:memory:`)
 *  - MotherDuck (connection string `md:<dbname>` + `motherduck_token`)
 *
 * Decisión clave: **una sola clase**, no dos. `@duckdb/node-api` habla con
 * MotherDuck nativamente vía el connection string `md:`, así que no hay
 * razón para mantener un cliente HTTP separado. La diferencia entre los dos
 * modos vive enteramente en cómo se construye el `DuckDBInstance`.
 *
 * Idempotencia: `applyBatch` usa `INSERT … ON CONFLICT (_id) DO UPDATE SET …`.
 * DuckDB lo soporta nativamente sobre cualquier columna con PRIMARY KEY o
 * UNIQUE constraint; nosotros declaramos `_id VARCHAR PRIMARY KEY` en
 * `ensureTable`. Re-aplicar el mismo batch dos veces = mismo estado final.
 *
 * Transacciones: el caller usa `withTransaction(async () => { … })`. Adentro
 * puede mezclar `applyBatch` + `applyDeletes` arbitrariamente, todo se
 * commitea junto o se hace rollback junto. Si algo lanza, la tx se aborta y
 * el cursor del componente NO debe avanzar (responsabilidad del caller).
 *
 * Concurrencia: el componente garantiza que sólo hay UNA action corriendo
 * por tabla en simultáneo (ver Fase 4/5), así que no hace falta serializar
 * acá. Si esa garantía se rompe, DuckDB serializa las txs por su cuenta
 * pero podríamos ver deadlocks lógicos — vamos a documentar la suposición
 * en el README.
 */

import {
  DuckDBConnection,
  DuckDBInstance,
} from "@duckdb/node-api";
import {
  type CellValue,
  type ColumnDef,
  type Destination,
  type DuckDestinationOptions,
  duckSqlType,
  type Row,
} from "@notchat/destination-types";

export type { DuckDestinationOptions } from "@notchat/destination-types";

/**
 * Crea y abre un destination según las opciones. La conexión queda viva
 * hasta `close()`. Para tests usar `{ kind: "duckdb_local", path: ":memory:" }`.
 */
export async function createDuckDestination(
  opts: DuckDestinationOptions,
): Promise<Destination> {
  let instance: DuckDBInstance;
  if (opts.kind === "duckdb_local") {
    instance = await DuckDBInstance.create(opts.path);
  } else {
    // El prefijo `md:` le dice a DuckDB que use la extensión motherduck.
    // El token va como connection option — la extensión lo lee de ahí en
    // vez de exigir `SET motherduck_token=…` post-conexión.
    instance = await DuckDBInstance.create(`md:${opts.database}`, {
      motherduck_token: opts.token,
    });
  }
  const conn = await instance.connect();
  return new DuckDestination(instance, conn);
}

class DuckDestination implements Destination {
  private inTx = false;

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  async ensureTable(
    name: string,
    columns: ReadonlyArray<ColumnDef>,
  ): Promise<void> {
    assertSafeIdent(name);
    for (const c of columns) assertSafeIdent(c.name);

    const exists = await this.tableExists(name);
    if (!exists) {
      // `_id` es siempre PRIMARY KEY, independiente del spec del usuario.
      // Si el usuario también declara `_id` en columns lo ignoramos (no lo
      // agregamos dos veces). El resto se agrega con su tipo lógico.
      const userCols = columns
        .filter((c) => c.name !== "_id")
        .map((c) => `${quoteIdent(c.name)} ${duckSqlType(c.type)}`);
      const ddl = `CREATE TABLE ${quoteIdent(name)} (\n  _id VARCHAR PRIMARY KEY${
        userCols.length > 0 ? ",\n  " + userCols.join(",\n  ") : ""
      }\n)`;
      await this.conn.run(ddl);
      return;
    }

    // Migración aditiva: si el spec declara columnas que no están en la
    // tabla, las agregamos. Cambios de tipo o columnas removidas NO se
    // tocan acá (Fase 7 decide qué hacer — probablemente forzar re-snapshot).
    const present = await this.columnNames(name);
    for (const c of columns) {
      if (c.name === "_id" || present.has(c.name)) continue;
      await this.conn.run(
        `ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${quoteIdent(c.name)} ${duckSqlType(c.type)}`,
      );
    }
  }

  async applyBatch(name: string, rows: ReadonlyArray<Row>): Promise<void> {
    if (rows.length === 0) return;
    this.assertInTx();
    assertSafeIdent(name);

    // Tomamos las columnas de la primera fila. Asumimos que todas las filas
    // del batch tienen el mismo shape — el caller (Convex streaming export)
    // siempre nos da filas de la misma tabla, así que es válido. Si en el
    // futuro permitimos filas heterogéneas, habría que prepared-statement
    // distinto por shape.
    const firstRow = rows[0]!;
    const cols = Object.keys(firstRow);
    for (const c of cols) assertSafeIdent(c);

    const placeholders = cols.map(() => "?").join(", ");
    const updateAssigns = cols
      .filter((c) => c !== "_id")
      .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
      .join(", ");

    const sql =
      `INSERT INTO ${quoteIdent(name)} (${cols.map(quoteIdent).join(", ")}) ` +
      `VALUES (${placeholders}) ` +
      (updateAssigns
        ? `ON CONFLICT (_id) DO UPDATE SET ${updateAssigns}`
        : `ON CONFLICT (_id) DO NOTHING`);

    // Una prepared statement reusada por fila. DuckDB no expone "executemany"
    // en este binding; un prepare + N runs es lo idiomático.
    const prepared = await this.conn.prepare(sql);
    for (const row of rows) {
      const bound = cols.map((c) => toDuckValue(row[c]));
      // Bind por índice (1-based en DuckDB prepared statements).
      for (let i = 0; i < bound.length; i++) {
        bindByJsType(prepared, i + 1, bound[i]);
      }
      await prepared.run();
    }
  }

  async applyDeletes(name: string, ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    this.assertInTx();
    assertSafeIdent(name);
    const prepared = await this.conn.prepare(
      `DELETE FROM ${quoteIdent(name)} WHERE _id = ?`,
    );
    for (const id of ids) {
      prepared.bindVarchar(1, id);
      await prepared.run();
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) {
      // No soportamos txs anidadas. DuckDB no las tiene; podríamos emular
      // con SAVEPOINT pero no lo necesitamos hoy. Romper en vez de aceptar
      // semántica ambigua.
      throw new Error(
        "DuckDestination.withTransaction: nested transactions not supported",
      );
    }
    this.inTx = true;
    await this.conn.run("BEGIN");
    try {
      const result = await fn();
      await this.conn.run("COMMIT");
      return result;
    } catch (err) {
      try {
        await this.conn.run("ROLLBACK");
      } catch {
        // Si el ROLLBACK falla (raro), no enmascaramos el error original.
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  async tableExists(name: string): Promise<boolean> {
    const reader = await this.conn.runAndReadAll(
      "SELECT 1 FROM information_schema.tables WHERE table_name = ? LIMIT 1",
      [name],
    );
    return reader.currentRowCount > 0;
  }

  async countRows(name: string): Promise<number> {
    assertSafeIdent(name);
    const reader = await this.conn.runAndReadAll(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`,
    );
    const rows = reader.getRowObjectsJS();
    const n = rows[0]?.n;
    if (typeof n === "number") return n;
    if (typeof n === "bigint") return Number(n);
    return 0;
  }

  async dropTable(name: string): Promise<void> {
    assertSafeIdent(name);
    await this.conn.run(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  }

  async close(): Promise<void> {
    try {
      this.conn.closeSync();
    } catch {
      // Ya cerrado: idempotente.
    }
    try {
      this.instance.closeSync();
    } catch {
      // Idempotente.
    }
  }

  private assertInTx(): void {
    if (!this.inTx) {
      throw new Error(
        "DuckDestination: applyBatch/applyDeletes must run inside withTransaction()",
      );
    }
  }

  async columnTypes(name: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const exists = await this.tableExists(name);
    if (!exists) return out;
    const reader = await this.conn.runAndReadAll(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?",
      [name],
    );
    for (const row of reader.getRowObjectsJS()) {
      const col = row.column_name;
      const typ = row.data_type;
      if (typeof col === "string" && typeof typ === "string") {
        out.set(col, typ.toUpperCase());
      }
    }
    return out;
  }

  private async columnNames(table: string): Promise<Set<string>> {
    const types = await this.columnTypes(table);
    return new Set(types.keys());
  }
}

/**
 * Normaliza un `CellValue` JS al valor que efectivamente bindeamos. Objetos
 * y arrays se serializan a JSON acá (DuckDB acepta strings JSON para la
 * columna JSON nativa). Strings, numbers, bigints, booleans, null pasan tal
 * cual.
 */
function toDuckValue(v: CellValue | undefined): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

/**
 * Bindea un valor JS a una prepared statement por índice. Hace dispatch al
 * método tipado correcto — DuckDB exige conocer el tipo de antemano para
 * bind, no infiere desde JS.
 */
function bindByJsType(
  stmt: import("@duckdb/node-api").DuckDBPreparedStatement,
  idx: number,
  value: unknown,
): void {
  if (value === null) {
    stmt.bindNull(idx);
    return;
  }
  switch (typeof value) {
    case "string":
      stmt.bindVarchar(idx, value);
      return;
    case "number":
      // Usamos double para cubrir floats Y enteros — Convex sólo tiene
      // `number` (IEEE 754) así que doble precisión es lo correcto.
      stmt.bindDouble(idx, value);
      return;
    case "bigint":
      stmt.bindBigInt(idx, value);
      return;
    case "boolean":
      stmt.bindBoolean(idx, value);
      return;
    default:
      throw new Error(
        `DuckDestination: unsupported bind type ${typeof value} at index ${idx}`,
      );
  }
}

/**
 * Whitelist conservadora para identificadores (tablas, columnas). Bloquea
 * cualquier cosa que no sea `[A-Za-z_][A-Za-z0-9_]*` para evitar
 * SQL injection cuando interpolamos nombres en strings de SQL.
 *
 * Por qué no usar sólo `quoteIdent`: `quoteIdent` previene la inyección por
 * el lado del valor del identificador, pero un nombre con comilla doble
 * embebida podría romper el quoting. Esta whitelist hace el invariante
 * obvio y barato de auditar.
 */
function assertSafeIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${JSON.stringify(name)}`);
  }
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}
