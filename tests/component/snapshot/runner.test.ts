/**
 * Tests del runner del snapshot. NO usan DuckDB ni Convex reales — usan un
 * `FakeDestination` in-memory y una fake `listSnapshot` con páginas predefinidas.
 *
 * Cubrimos:
 *  - Snapshot completo multi-página (cursor avanza, snapshotTs persiste).
 *  - Reanudación: si ya hay un cursor guardado, la siguiente página parte de ahí.
 *  - Recovery tras crash: si la tx commitea pero saveProgress falla, la página
 *    siguiente repite la misma request → batch idempotente → no se duplica nada.
 *  - Schema estricto: campos extra se descartan con warning, el destino sólo
 *    ve columnas declaradas.
 *  - `hasMore: false` sin `snapshotTs` revienta con error claro (no avanzamos a
 *    deltas sin punto de partida válido).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CellValue,
  ColumnDef,
  Destination,
  Row,
} from "@notchat/destination-types";
import type { ListSnapshotPage } from "../../../packages/convex-sync-motherduck/src/streaming/listSnapshot";
import {
  processSnapshotPage,
  type SnapshotIO,
  type SnapshotProgress,
} from "../../../packages/convex-sync-motherduck/src/snapshot/runner";

const COLUMNS: ReadonlyArray<ColumnDef> = [
  { name: "_id", type: "string" },
  { name: "name", type: "string" },
  { name: "age", type: "number" },
];

class FakeDestination implements Destination {
  // tableName → _id → row
  readonly tables = new Map<string, Map<string, Row>>();
  readonly schemas = new Map<string, ReadonlyArray<ColumnDef>>();
  private inTx = false;

  async ensureTable(name: string, columns: ReadonlyArray<ColumnDef>) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    this.schemas.set(name, columns);
  }
  async applyBatch(name: string, rows: ReadonlyArray<Row>) {
    if (!this.inTx) throw new Error("not in tx");
    const t = this.tables.get(name)!;
    for (const r of rows) t.set(r._id, { ...r });
  }
  async applyDeletes(name: string, ids: ReadonlyArray<string>) {
    if (!this.inTx) throw new Error("not in tx");
    const t = this.tables.get(name)!;
    for (const id of ids) t.delete(id);
  }
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.inTx = true;
    try {
      return await fn();
    } finally {
      this.inTx = false;
    }
  }
  async tableExists(name: string) {
    return this.tables.has(name);
  }
  async countRows(name: string) {
    return this.tables.get(name)?.size ?? 0;
  }
  async dropTable(name: string) {
    this.tables.delete(name);
  }
  async close() {}
}

class FakeIO implements SnapshotIO {
  readonly progress = new Map<string, SnapshotProgress>();
  readonly done = new Map<string, number>();
  readonly warnings: Array<{ message: string; ctx: Record<string, unknown> }> =
    [];

  async loadProgress(t: string): Promise<SnapshotProgress> {
    return (
      this.progress.get(t) ?? { cursor: undefined, rowsApplied: 0 }
    );
  }
  async saveProgress(t: string, p: SnapshotProgress) {
    this.progress.set(t, p);
  }
  async markSnapshotDone(t: string, ts: number) {
    this.done.set(t, ts);
  }
  logWarning(message: string, ctx: Record<string, unknown>) {
    this.warnings.push({ message, ctx });
  }
}

/** Genera un `fetchPage` falso que devuelve la cola de páginas en orden. */
function fakeFetcher(pages: ListSnapshotPage[]) {
  const queue = [...pages];
  const calls: Array<{ tableName: string; cursor: string | undefined }> = [];
  const fn = vi.fn(
    async (args: {
      tableName: string;
      cursor?: string;
    }): Promise<ListSnapshotPage> => {
      calls.push({ tableName: args.tableName, cursor: args.cursor });
      const next = queue.shift();
      if (!next) throw new Error("fakeFetcher: queue empty");
      return next;
    },
  );
  return { fn, calls };
}

const SPEC = { name: "contacts", columns: COLUMNS };

describe("processSnapshotPage", () => {
  it("snapshot completo multi-página: cursor avanza, snapshotTs persiste", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn: fetchPage, calls } = fakeFetcher([
      {
        values: [
          { _id: "a", _creationTime: 1, name: "A", age: 1 },
          { _id: "b", _creationTime: 2, name: "B", age: 2 },
        ],
        cursor: "c1",
        hasMore: true,
      },
      {
        values: [{ _id: "c", _creationTime: 3, name: "C", age: 3 }],
        cursor: "c2",
        hasMore: false,
        snapshotTs: 1234567,
      },
    ]);

    const r1 = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage,
    });
    expect(r1).toEqual({ kind: "more", cursor: "c1", rowsAppliedThisPage: 2 });
    expect(calls[0]?.cursor).toBeUndefined();
    expect(io.progress.get("contacts")).toEqual({
      cursor: "c1",
      rowsApplied: 2,
    });

    const r2 = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage,
    });
    expect(r2).toEqual({
      kind: "done",
      snapshotTs: 1234567,
      rowsAppliedThisPage: 1,
    });
    expect(calls[1]?.cursor).toBe("c1");
    expect(io.done.get("contacts")).toBe(1234567);
    expect(await dst.countRows("contacts")).toBe(3);
  });

  it("recovery: si saveProgress falla tras commit, repetir página no duplica filas", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    // Mismo `pages` se usa dos veces: simulamos que la primera vez crasheamos
    // después del batch pero antes de avanzar el cursor — al reintentar pedimos
    // la misma página (cursor undefined) y aplicamos las mismas filas. La
    // idempotencia del destino garantiza que el conteo no se infla.
    const page: ListSnapshotPage = {
      values: [
        { _id: "a", _creationTime: 1, name: "A", age: 1 },
        { _id: "b", _creationTime: 2, name: "B", age: 2 },
      ],
      cursor: "c1",
      hasMore: false,
      snapshotTs: 42,
    };

    // Primer intento: forzamos crash en saveProgress.
    const ioBoom: SnapshotIO = {
      ...io,
      loadProgress: io.loadProgress.bind(io),
      markSnapshotDone: io.markSnapshotDone.bind(io),
      saveProgress: async () => {
        throw new Error("simulated crash before cursor commit");
      },
      logWarning: io.logWarning.bind(io),
    };

    const fetcher1 = fakeFetcher([page]);
    await expect(
      processSnapshotPage({
        origin: "http://x",
        deployKey: "k",
        table: SPEC,
        destination: dst,
        io: ioBoom,
        fetchPage: fetcher1.fn,
      }),
    ).rejects.toThrow("simulated crash");

    // El destino YA tiene las filas (commit pasó).
    expect(await dst.countRows("contacts")).toBe(2);
    // Pero el cursor NO avanzó.
    expect(io.progress.get("contacts")).toBeUndefined();

    // Segundo intento (reanudación): mismo page, ahora saveProgress funciona.
    const fetcher2 = fakeFetcher([page]);
    const r = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage: fetcher2.fn,
    });
    expect(r.kind).toBe("done");
    // No se duplicó nada — siguen siendo 2 filas (idempotencia).
    expect(await dst.countRows("contacts")).toBe(2);
    expect(io.done.get("contacts")).toBe(42);
  });

  it("schema estricto: descarta campos no declarados con warning", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [
          {
            _id: "a",
            _creationTime: 1,
            name: "A",
            age: 1,
            email: "secret@x.com", // no declarado
            internalScore: 99, // no declarado
          },
        ],
        cursor: "c1",
        hasMore: false,
        snapshotTs: 1,
      },
    ]);

    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage: fn,
    });

    const stored = dst.tables.get("contacts")!.get("a")!;
    expect(Object.keys(stored).sort()).toEqual(["_id", "age", "name"]);
    expect(io.warnings).toHaveLength(1);
    expect(io.warnings[0]!.ctx).toMatchObject({
      tableName: "contacts",
      extras: ["email", "internalScore"],
    });
  });

  it("_creationTime se descarta silenciosamente (sin warning)", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [{ _id: "a", _creationTime: 99, name: "A", age: 1 }],
        cursor: "c1",
        hasMore: false,
        snapshotTs: 1,
      },
    ]);
    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage: fn,
    });
    expect(io.warnings).toHaveLength(0);
  });

  it("hasMore=false sin snapshotTs revienta", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [],
        cursor: "c1",
        hasMore: false,
        // snapshotTs intencionalmente ausente
      },
    ]);
    await expect(
      processSnapshotPage({
        origin: "http://x",
        deployKey: "k",
        table: SPEC,
        destination: dst,
        io,
        fetchPage: fn,
      }),
    ).rejects.toThrow(/snapshotTs/);
  });

  it("documento sin _id revienta visible", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [{ name: "anon", age: 0 } as unknown as {
          _id: string;
          _creationTime: number;
        }],
        cursor: "c1",
        hasMore: true,
      },
    ]);
    await expect(
      processSnapshotPage({
        origin: "http://x",
        deployKey: "k",
        table: SPEC,
        destination: dst,
        io,
        fetchPage: fn,
      }),
    ).rejects.toThrow(/missing _id/);
  });

  it("página vacía no escribe pero igual avanza el cursor", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      { values: [], cursor: "c1", hasMore: true },
    ]);
    const r = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchPage: fn,
    });
    expect(r).toEqual({ kind: "more", cursor: "c1", rowsAppliedThisPage: 0 });
    expect(io.progress.get("contacts")).toEqual({
      cursor: "c1",
      rowsApplied: 0,
    });
  });
});

// Silencia warning de unused (TS strict) — los tipos son usados por las clases.
type _Unused = CellValue;
