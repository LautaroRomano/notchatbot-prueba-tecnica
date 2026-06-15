// @vitest-environment node
//
// Por qué `node` y no `edge-runtime` (default del repo): `@duckdb/node-api`
// es un native addon de Node, no corre en edge-runtime. La directiva de
// arriba override-ea el environment global SÓLO para este archivo —
// el resto de los tests (convex-test) sigue en edge-runtime.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDuckDestination } from "@notchat/duck-destination";
import type { Destination, Row } from "@notchat/destination-types";
import { detectTypeChanges } from "../../../packages/convex-sync-motherduck/src/client/index";

const SPEC = [
  { name: "_id", type: "string" as const },
  { name: "name", type: "string" as const },
  { name: "age", type: "number" as const },
  { name: "active", type: "boolean" as const },
  { name: "meta", type: "json" as const },
];

describe("DuckDestination (in-memory)", () => {
  let dst: Destination;

  beforeEach(async () => {
    // `:memory:` da una DB efímera por test — aislamiento total, no necesita
    // limpieza de tmp files y es lo bastante rápido para no preocuparse.
    dst = await createDuckDestination({
      kind: "duckdb_local",
      path: ":memory:",
    });
  });

  afterEach(async () => {
    await dst.close();
  });

  it("ensureTable crea la tabla con _id PRIMARY KEY", async () => {
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
    expect(await dst.countRows("contacts")).toBe(0);
  });

  it("ensureTable es idempotente", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
  });

  it("applyBatch upsertea filas y countRows refleja el total", async () => {
    await dst.ensureTable("contacts", SPEC);
    const rows: Row[] = [
      { _id: "a", name: "Alice", age: 30, active: true, meta: { tag: "vip" } },
      { _id: "b", name: "Bob", age: 25, active: false, meta: null },
    ];
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    expect(await dst.countRows("contacts")).toBe(2);
  });

  it("applyBatch es idempotente (re-aplicar deja el mismo estado)", async () => {
    await dst.ensureTable("contacts", SPEC);
    const rows: Row[] = [
      { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      { _id: "b", name: "Bob", age: 25, active: false, meta: null },
    ];
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    expect(await dst.countRows("contacts")).toBe(2);
  });

  it("applyBatch actualiza (no duplica) cuando _id ya existe", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice updated", age: 31, active: false, meta: null },
      ]),
    );
    expect(await dst.countRows("contacts")).toBe(1);
    // Validamos la actualización con una consulta directa al motor.
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT name, age, active FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    expect(row).toEqual({ name: "Alice updated", age: 31, active: false });
  });

  it("applyDeletes borra por _id", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
        { _id: "b", name: "Bob", age: 25, active: false, meta: null },
      ]),
    );
    await dst.withTransaction(() => dst.applyDeletes("contacts", ["a"]));
    expect(await dst.countRows("contacts")).toBe(1);
  });

  it("withTransaction rollback ante error preserva el estado", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    await expect(
      dst.withTransaction(async () => {
        await dst.applyBatch("contacts", [
          { _id: "b", name: "Bob", age: 25, active: false, meta: null },
        ]);
        throw new Error("simulated failure mid-batch");
      }),
    ).rejects.toThrow("simulated failure");
    // La fila `b` NO debe estar — rollback la tiró.
    expect(await dst.countRows("contacts")).toBe(1);
  });

  it("ensureTable hace ALTER ADD COLUMN aditivo", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    // Re-llamamos con una columna nueva.
    await dst.ensureTable("contacts", [
      ...SPEC,
      { name: "nickname", type: "string" },
    ]);
    // La fila vieja sigue ahí, con `nickname` en NULL.
    expect(await dst.countRows("contacts")).toBe(1);
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT nickname FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    expect(row).toEqual({ nickname: null });
  });

  it("dropTable saca la tabla y tableExists vuelve a false", async () => {
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
    await dst.dropTable("contacts");
    expect(await dst.tableExists("contacts")).toBe(false);
  });

  it("applyBatch fuera de tx falla con mensaje claro", async () => {
    await dst.ensureTable("contacts", SPEC);
    await expect(
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    ).rejects.toThrow(/must run inside withTransaction/);
  });

  it("rechaza identificadores inseguros", async () => {
    await expect(
      dst.ensureTable("contacts; DROP TABLE foo", SPEC),
    ).rejects.toThrow(/Unsafe identifier/);
  });

  it("serializa JSON cuando la columna es de tipo json", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        {
          _id: "a",
          name: "Alice",
          age: 30,
          active: true,
          meta: { tags: ["vip", "early"], score: 7 },
        },
      ]),
    );
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT meta->>'$.score' AS score FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    // DuckDB devuelve el campo extraído como string.
    expect(String(row?.score)).toBe("7");
  });

  // ---- Schema migrations — Fase 7 -----------------------------------------

  it("columnTypes devuelve mapa de columnas y sus tipos SQL", async () => {
    await dst.ensureTable("contacts", SPEC);
    const types = await dst.columnTypes("contacts");
    expect(types.get("_id")).toBe("VARCHAR");
    expect(types.get("name")).toBe("VARCHAR");
    expect(types.get("age")).toBe("DOUBLE");
    expect(types.get("active")).toBe("BOOLEAN");
    expect(types.get("meta")).toBe("JSON");
  });

  it("columnTypes devuelve mapa vacío si la tabla no existe", async () => {
    const types = await dst.columnTypes("no_existe");
    expect(types.size).toBe(0);
  });

  it("detectTypeChanges: sin cambios devuelve lista vacía", async () => {
    await dst.ensureTable("contacts", SPEC);
    const changed = await detectTypeChanges("contacts", SPEC, dst);
    expect(changed).toEqual([]);
  });

  it("detectTypeChanges: detecta columna con tipo cambiado", async () => {
    // Crear tabla con age como DOUBLE (tipo "number").
    await dst.ensureTable("contacts", SPEC);
    // Ahora el caller declara age como "string" → tipo SQL esperado VARCHAR.
    const newSpec = SPEC.map((c) =>
      c.name === "age" ? { ...c, type: "string" as const } : c,
    );
    const changed = await detectTypeChanges("contacts", newSpec, dst);
    expect(changed).toContain("age");
    expect(changed).not.toContain("name"); // name sigue siendo string → VARCHAR ✓
  });

  it("detectTypeChanges: columna nueva no es cambio de tipo (es migración aditiva)", async () => {
    await dst.ensureTable("contacts", SPEC);
    // Añadimos una columna nueva que todavía no está en DuckDB.
    const withExtra = [...SPEC, { name: "nickname", type: "string" as const }];
    const changed = await detectTypeChanges("contacts", withExtra, dst);
    // "nickname" no está en DuckDB aún → no es un cambio de tipo.
    expect(changed).not.toContain("nickname");
    expect(changed).toHaveLength(0);
  });

  it("detectTypeChanges: tabla inexistente devuelve lista vacía", async () => {
    const changed = await detectTypeChanges("no_existe", SPEC, dst);
    expect(changed).toHaveLength(0);
  });
});
