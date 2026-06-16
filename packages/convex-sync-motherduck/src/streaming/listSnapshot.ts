/**
 * Cliente del endpoint `list_snapshot` del Streaming Export de Convex.
 *
 * Docs: https://docs.convex.dev/database/streaming-export
 *       https://docs.convex.dev/http-api/#streaming-export
 *
 * Contrato del endpoint:
 *  - Devuelve filas de UNA tabla en páginas ordenadas, con un cursor opaco.
 *  - `hasMore: false` significa "fin del snapshot" — junto con eso viene
 *    `snapshotTs`, el timestamp lógico desde el que tenemos que arrancar
 *    `document_deltas` para no perder ni duplicar nada en el handoff.
 *  - El cursor es opaco — no lo parseamos. Lo guardamos tal cual en
 *    `syncCursors` y se lo devolvemos al server en la próxima llamada.
 *
 * Autenticación: usamos el `deployKey` del singleton `syncConfig` como
 * `Authorization: Convex <key>`. Es el mismo esquema que la API HTTP
 * estándar de Convex; el endpoint de streaming export sólo está habilitado
 * en self-hosted (free) o en planes pagos (cloud), no en cloud free.
 */

/**
 * Documento devuelto por el endpoint. La forma es `{ _id, _creationTime, ...fields }`.
 * Lo tipamos como `Record<string, unknown>` porque el shape depende de la
 * tabla del usuario — el componente no conoce los schemas de la app huésped.
 */
export type SnapshotDocument = Record<string, unknown> & {
  _id: string;
  _creationTime: number;
};

export type ListSnapshotPage = {
  values: SnapshotDocument[];
  cursor: string;
  hasMore: boolean;
  /**
   * Timestamp del snapshot (microsegundos). Presente al menos cuando
   * `hasMore: false`; en páginas intermedias también lo manda — lo guardamos
   * recién al cierre para no perder consistencia si el snapshot se reanuda
   * desde una página vieja.
   */
  snapshotTs?: number;
};

export type ListSnapshotArgs = {
  origin: string;
  deployKey: string;
  tableName: string;
  /** Cursor opaco devuelto por la página anterior. `undefined` = primera llamada. */
  cursor?: string;
  /**
   * `signal` para abortar — útil si el host quiere matar el snapshot a la
   * mitad por shutdown limpio. Convex action ctx no expone signal pero lo
   * dejamos preparado para tests y futuro uso.
   */
  signal?: AbortSignal;
};

/**
 * Hace una llamada al endpoint y devuelve la página parseada. NO maneja
 * retries — eso es responsabilidad del runner (Fase 4) que sabe combinarlos
 * con el backoff de `syncedTables.lastError`.
 *
 * Errores que lanza:
 *  - `Error("list_snapshot HTTP <status>: <body>")` si el server no devuelve 2xx.
 *  - `TypeError` si la respuesta no parsea como JSON (red corrompida).
 */
export async function listSnapshot(
  args: ListSnapshotArgs,
): Promise<ListSnapshotPage> {
  // self-hosted: /api/list_snapshot; cloud: /api/streaming_export/list_snapshot
  const url = new URL("/api/list_snapshot", args.origin);
  url.searchParams.set("tableName", args.tableName);
  if (args.cursor !== undefined) {
    url.searchParams.set("cursor", args.cursor);
  }

  const init: RequestInit = {
    method: "GET",
    headers: {
      Authorization: `Convex ${args.deployKey}`,
      Accept: "application/json",
    },
  };
  if (args.signal) init.signal = args.signal;
  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(
      `list_snapshot HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as unknown;
  return parsePage(json);
}

/**
 * Validación defensiva del shape de la respuesta. Si Convex cambia el
 * formato (poco probable pero pasa), preferimos un error claro acá a
 * que el runner explote más adentro con un cast mal hecho.
 */
function parsePage(json: unknown): ListSnapshotPage {
  if (json === null || typeof json !== "object") {
    throw new Error(`list_snapshot: response is not an object`);
  }
  const obj = json as Record<string, unknown>;
  const values = obj.values;
  if (!Array.isArray(values)) {
    throw new Error(`list_snapshot: 'values' missing or not an array`);
  }
  const cursor = obj.cursor;
  // self-hosted returns cursor: null on the last page (hasMore: false)
  if (cursor !== null && typeof cursor !== "string") {
    throw new Error(`list_snapshot: 'cursor' is not a string or null`);
  }
  const hasMore = obj.hasMore;
  if (typeof hasMore !== "boolean") {
    throw new Error(`list_snapshot: 'hasMore' missing or not a boolean`);
  }
  // self-hosted uses 'snapshot'; cloud uses 'snapshotTs'
  const snapshotTs = obj.snapshotTs ?? obj.snapshot;
  const page: ListSnapshotPage = {
    values: values as SnapshotDocument[],
    cursor: cursor ?? "",
    hasMore,
  };
  if (typeof snapshotTs === "number") page.snapshotTs = snapshotTs;
  return page;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}
