/**
 * Tests del watchdog. La función `watchdogDecide` es pura — recibe el estado
 * de las tablas y una interfaz mínima del destino, devuelve acciones.
 * No levanta Convex ni DuckDB.
 *
 * Cubrimos:
 *  - Tabla `pending` → arrancar snapshot.
 *  - Tabla `running_snapshot` trabada → reintentar snapshot.
 *  - Tabla `running_snapshot` activa (reciente) → no tocar.
 *  - Tabla `running_delta` con tabla existente en destino → reiniciar delta
 *    si estuvo detenida más de `deltaRestartMs`.
 *  - Tabla `running_delta` con tabla BORRADA del destino → reset_and_snapshot.
 *  - Tabla `error` en fase snapshot con backoff vencido → reintentar snapshot.
 *  - Tabla `error` en fase delta con backoff vencido → reintentar delta.
 *  - Tabla `error` con backoff activo → no tocar.
 *  - Tabla `paused` → no tocar.
 *  - Sin destino (null) → se salta la comprobación de tableExists.
 */

import { describe, expect, it } from "vitest";
import { watchdogDecide, type WatchdogTableState } from "../../../packages/convex-sync-motherduck/src/watchdog/index";

const NOW = 1_000_000;

function makeTable(overrides: Partial<WatchdogTableState>): WatchdogTableState {
  return {
    name: "contacts",
    status: "pending",
    lastAppliedAtMs: undefined,
    snapshotTs: undefined,
    lastError: undefined,
    ...overrides,
  };
}

// Destino fake que indica si la tabla existe.
function fakeDestination(exists: boolean) {
  return {
    tableExists: async (_name: string) => exists,
  };
}

describe("watchdogDecide", () => {
  it("pending → start_snapshot", async () => {
    const actions = await watchdogDecide(
      [makeTable({ status: "pending" })],
      null,
      NOW,
    );
    expect(actions).toEqual([
      { kind: "start_snapshot", tableName: "contacts", reason: expect.stringContaining("pending") },
    ]);
  });

  it("running_snapshot trabado → start_snapshot", async () => {
    const actions = await watchdogDecide(
      [makeTable({ status: "running_snapshot", lastAppliedAtMs: NOW - 130_000 })],
      null,
      NOW,
      { stuckSnapshotMs: 120_000 },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("start_snapshot");
  });

  it("running_snapshot activo (reciente) → no tocar", async () => {
    const actions = await watchdogDecide(
      [makeTable({ status: "running_snapshot", lastAppliedAtMs: NOW - 10_000 })],
      null,
      NOW,
      { stuckSnapshotMs: 120_000 },
    );
    expect(actions).toHaveLength(0);
  });

  it("running_delta con tabla existente y job detenido → start_delta", async () => {
    const dst = fakeDestination(true);
    const actions = await watchdogDecide(
      [makeTable({ status: "running_delta", snapshotTs: 42, lastAppliedAtMs: NOW - 20_000 })],
      dst,
      NOW,
      { deltaRestartMs: 15_000 },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("start_delta");
  });

  it("running_delta con tabla existente y job reciente → no tocar", async () => {
    const dst = fakeDestination(true);
    const actions = await watchdogDecide(
      [makeTable({ status: "running_delta", snapshotTs: 42, lastAppliedAtMs: NOW - 5_000 })],
      dst,
      NOW,
      { deltaRestartMs: 15_000 },
    );
    expect(actions).toHaveLength(0);
  });

  it("running_delta con tabla BORRADA del destino → reset_and_snapshot", async () => {
    const dst = fakeDestination(false);
    const actions = await watchdogDecide(
      [makeTable({ status: "running_delta", snapshotTs: 42, lastAppliedAtMs: NOW - 5_000 })],
      dst,
      NOW,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("reset_and_snapshot");
    expect(actions[0]!.tableName).toBe("contacts");
  });

  it("running_delta sin destino disponible → no hace reset (salta tableExists)", async () => {
    const actions = await watchdogDecide(
      [makeTable({ status: "running_delta", snapshotTs: 42, lastAppliedAtMs: NOW - 20_000 })],
      null,
      NOW,
      { deltaRestartMs: 15_000 },
    );
    // Sin destino no puede verificar tableExists → decide start_delta de todas formas.
    expect(actions[0]!.kind).toBe("start_delta");
  });

  it("error en fase snapshot con backoff vencido → start_snapshot", async () => {
    const actions = await watchdogDecide(
      [makeTable({
        status: "error",
        snapshotTs: undefined, // nunca completó snapshot
        lastAppliedAtMs: NOW - 35_000,
        lastError: "connection refused",
      })],
      null,
      NOW,
      { errorRetryMs: 30_000 },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("start_snapshot");
  });

  it("error en fase delta con backoff vencido → start_delta", async () => {
    const actions = await watchdogDecide(
      [makeTable({
        status: "error",
        snapshotTs: 99, // snapshot sí completó
        lastAppliedAtMs: NOW - 35_000,
        lastError: "timeout",
      })],
      null,
      NOW,
      { errorRetryMs: 30_000 },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("start_delta");
  });

  it("error con backoff activo → no tocar", async () => {
    const actions = await watchdogDecide(
      [makeTable({
        status: "error",
        lastAppliedAtMs: NOW - 10_000,
        lastError: "boom",
      })],
      null,
      NOW,
      { errorRetryMs: 30_000 },
    );
    expect(actions).toHaveLength(0);
  });

  it("paused → no tocar", async () => {
    const actions = await watchdogDecide(
      [makeTable({ status: "paused" })],
      null,
      NOW,
    );
    expect(actions).toHaveLength(0);
  });

  it("múltiples tablas en distintos estados → acción por cada una", async () => {
    const dst = fakeDestination(true);
    const tables: WatchdogTableState[] = [
      makeTable({ name: "contacts", status: "pending" }),
      makeTable({ name: "messages", status: "running_delta", snapshotTs: 1, lastAppliedAtMs: NOW - 20_000 }),
      makeTable({ name: "tenants", status: "paused" }),
    ];
    const actions = await watchdogDecide(tables, dst, NOW, { deltaRestartMs: 15_000 });
    expect(actions).toHaveLength(2);
    expect(actions.find((a) => a.tableName === "contacts")!.kind).toBe("start_snapshot");
    expect(actions.find((a) => a.tableName === "messages")!.kind).toBe("start_delta");
  });
});
