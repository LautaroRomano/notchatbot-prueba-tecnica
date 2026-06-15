/**
 * Cliente del endpoint `document_deltas` del Streaming Export de Convex.
 *
 * Docs: https://docs.convex.dev/database/streaming-export
 *       https://docs.convex.dev/http-api/#streaming-export
 *
 * Contrato del endpoint:
 *  - Recibe `cursor` — en la primera llamada post-snapshot es el `snapshotTs`
 *    (como string), en las siguientes es el cursor opaco devuelto por la
 *    respuesta anterior.
 *  - Devuelve entradas ordenadas por `ts` (timestamp de Convex, microsegundos).
 *  - `action: "insert" | "replace"` → campos presentes en `fields`.
 *  - `action: "delete"` → tombstone, `fields` ausente. Sólo viene `id`.
 *  - `hasMore: false` + cursor vacío de cambios significa "alcanzamos el live".
 *
 * NO maneja retries — responsabilidad del runner que combina con backoff.
 */

export type DeltaAction = "insert" | "replace" | "delete";

export type DeltaEntry = {
  ts: number;
  id: string;
  action: DeltaAction;
  /** Presente para insert/replace; ausente en deletes (tombstone). */
  fields?: Record<string, unknown> & { _id: string; _creationTime: number };
};

export type DeltaPage = {
  values: DeltaEntry[];
  cursor: string;
  hasMore: boolean;
};

export type DocumentDeltasArgs = {
  origin: string;
  deployKey: string;
  tableName: string;
  /** Cursor opaco. Primera llamada: String(snapshotTs). */
  cursor: string;
  signal?: AbortSignal;
};

/**
 * Llama al endpoint y devuelve la página parseada.
 * Lanza `Error("document_deltas HTTP <status>: <body>")` si no devuelve 2xx.
 */
export async function documentDeltas(
  args: DocumentDeltasArgs,
): Promise<DeltaPage> {
  const url = new URL(
    "/api/streaming_export/document_deltas",
    args.origin,
  );
  url.searchParams.set("tableName", args.tableName);
  url.searchParams.set("cursor", args.cursor);

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
      `document_deltas HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as unknown;
  return parseDeltaPage(json);
}

function parseDeltaPage(json: unknown): DeltaPage {
  if (json === null || typeof json !== "object") {
    throw new Error("document_deltas: response is not an object");
  }
  const obj = json as Record<string, unknown>;

  const values = obj.values;
  if (!Array.isArray(values)) {
    throw new Error("document_deltas: 'values' missing or not an array");
  }
  const cursor = obj.cursor;
  if (typeof cursor !== "string") {
    throw new Error("document_deltas: 'cursor' missing or not a string");
  }
  const hasMore = obj.hasMore;
  if (typeof hasMore !== "boolean") {
    throw new Error("document_deltas: 'hasMore' missing or not a boolean");
  }

  return {
    values: values.map(parseDeltaEntry),
    cursor,
    hasMore,
  };
}

function parseDeltaEntry(raw: unknown): DeltaEntry {
  if (raw === null || typeof raw !== "object") {
    throw new Error("document_deltas: entry is not an object");
  }
  const e = raw as Record<string, unknown>;

  const ts = e.ts;
  if (typeof ts !== "number") {
    throw new Error("document_deltas: entry.ts missing or not a number");
  }
  const id = e.id;
  if (typeof id !== "string") {
    throw new Error("document_deltas: entry.id missing or not a string");
  }
  const action = e.action;
  if (action !== "insert" && action !== "replace" && action !== "delete") {
    throw new Error(
      `document_deltas: entry.action invalid: ${String(action)}`,
    );
  }

  const entry: DeltaEntry = { ts, id, action };
  if (action !== "delete" && e.fields !== undefined) {
    entry.fields = e.fields as DeltaEntry["fields"];
  }
  return entry;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}
