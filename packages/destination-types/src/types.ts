/**
 * Tipos públicos del adapter de destino (DuckDB local / MotherDuck).
 *
 * El componente trata al destino como una caja negra que sabe:
 *  - crear/migrar tablas (`ensureTable`),
 *  - aplicar batches de filas de forma idempotente (`applyBatch`),
 *  - aplicar deletes por `_id` (`applyDeletes`),
 *  - reportar existencia y cardinalidad (`tableExists`, `countRows`),
 *  - destruir una tabla (`dropTable`) — sólo para tests y para el reset que
 *    hace el self-heal cuando detecta que alguien borró la tabla destino.
 *
 * Todas las operaciones de escritura se ejecutan dentro de UNA transacción
 * (el caller envuelve con `withTransaction`). Si la tx falla, el cursor de
 * sync no avanza y el siguiente intento reaplica el mismo batch — por eso
 * `applyBatch` usa `INSERT … ON CONFLICT (_id) DO UPDATE`: re-aplicar el
 * mismo batch deja el destino en el mismo estado.
 */

/** Tipo lógico de columna. Mapea a SQL en `duckSqlType`. */
export type LogicalType =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "json"
  | "timestamp_ms";

export type ColumnDef = {
  name: string;
  type: LogicalType;
};

/**
 * Valor que aceptamos para una celda. `null` se mapea a NULL.
 * Objetos/arrays se serializan a JSON cuando la columna es de tipo `json`.
 */
export type CellValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

/** Fila genérica. Debe incluir siempre la columna `_id`. */
export type Row = Record<string, CellValue> & { _id: string };

export interface Destination {
  /**
   * Crea la tabla si no existe. Si existe, agrega columnas faltantes con
   * `ALTER TABLE … ADD COLUMN` (migración aditiva). Cambios de tipo de una
   * columna existente NO se aplican acá — Fase 7 los va a manejar marcando
   * la tabla para re-snapshot.
   *
   * La columna `_id` es siempre `VARCHAR PRIMARY KEY`, independiente del
   * spec del usuario.
   */
  ensureTable(name: string, columns: ReadonlyArray<ColumnDef>): Promise<void>;

  /**
   * Inserta o actualiza filas usando `_id` como clave. Re-aplicar el mismo
   * batch produce el mismo estado (idempotente).
   *
   * Debe ejecutarse adentro de `withTransaction`. El caller decide el alcance
   * de la transacción para alinear el commit con el avance del cursor.
   */
  applyBatch(name: string, rows: ReadonlyArray<Row>): Promise<void>;

  /** Borra filas por `_id`. Debe ejecutarse adentro de `withTransaction`. */
  applyDeletes(name: string, ids: ReadonlyArray<string>): Promise<void>;

  /**
   * Envuelve un bloque de operaciones en `BEGIN … COMMIT`. Si el callback
   * lanza, hace `ROLLBACK` y re-lanza. Esta es la única forma soportada de
   * llamar a `applyBatch` / `applyDeletes`.
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  tableExists(name: string): Promise<boolean>;
  countRows(name: string): Promise<number>;

  /** Sólo para tests y para reset del self-heal. */
  dropTable(name: string): Promise<void>;

  /** Cierra la conexión. Idempotente. */
  close(): Promise<void>;
}

/**
 * Opciones para construir el destino. Vive acá (no en `duck.ts`) para que
 * el componente Convex pueda importar el tipo sin arrastrar el native addon
 * de DuckDB al bundle del isolate V8.
 */
export type DuckDestinationOptions =
  | { kind: "duckdb_local"; path: string }
  | {
      kind: "motherduck";
      /** Nombre de la DB en MotherDuck (sin el prefijo `md:`). */
      database: string;
      /** Token de MotherDuck. Se inyecta como connection option. */
      token: string;
    };

/**
 * Mapeo de tipo lógico → SQL de DuckDB. JSON usa el tipo nativo `JSON` de
 * DuckDB (sin restricciones, indexable). Timestamps los almacenamos como
 * BIGINT (epoch ms) — Convex usa `number` y no queremos perder precisión
 * con conversiones de TIMESTAMP.
 */
export function duckSqlType(t: LogicalType): string {
  switch (t) {
    case "string":
      return "VARCHAR";
    case "number":
      return "DOUBLE";
    case "bigint":
      return "BIGINT";
    case "boolean":
      return "BOOLEAN";
    case "json":
      return "JSON";
    case "timestamp_ms":
      return "BIGINT";
  }
}
