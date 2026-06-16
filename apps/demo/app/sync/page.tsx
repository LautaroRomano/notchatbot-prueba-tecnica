"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

// Colores por estado — se usan como inline styles para no depender de CSS externo.
const STATUS_COLOR: Record<string, string> = {
  pending: "#f59e0b",
  running_snapshot: "#3b82f6",
  running_delta: "#10b981",
  error: "#ef4444",
  paused: "#6b7280",
  idle: "#6b7280",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#6b7280";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        background: color,
        color: "#fff",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {status}
    </span>
  );
}

function fmtTs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleTimeString();
}

function fmtCursor(cursor: string | undefined): string {
  if (!cursor) return "—";
  return cursor.length > 20 ? cursor.slice(0, 20) + "…" : cursor;
}

export default function SyncPage() {
  const tables = useQuery(api.sync.status);

  if (tables === undefined) {
    return (
      <main>
        <h1>Sync status</h1>
        <p style={{ color: "#6b7280" }}>Conectando a Convex…</p>
      </main>
    );
  }

  if (tables.length === 0) {
    return (
      <main>
        <h1>Sync status</h1>
        <p style={{ color: "#6b7280" }}>
          No hay tablas registradas. El seed no registra el sync: primero
          configurá el destino y después registrá las tablas (ver{" "}
          <code>SETUP.md</code> pasos 6–7).
        </p>
        <pre
          style={{
            background: "#f3f4f6",
            padding: 12,
            borderRadius: 8,
            fontSize: 13,
            overflow: "auto",
          }}
        >
          {`# Desde la raíz del repo:
bun run --cwd apps/demo convex:run-json -- sync:setConfig ./scripts/sync-set-config.local.json
bun run --cwd apps/demo convex:run-json -- sync:register ./scripts/sync-register.local.json.example`}
        </pre>
        <p>
          <a href="/">← Inicio</a>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Sync status</h1>
      <p style={{ color: "#6b7280", marginBottom: 16 }}>
        Se actualiza en tiempo real vía Convex. Recargá la página si el
        backend acaba de arrancar.
      </p>

      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ background: "#f3f4f6" }}>
            {["Tabla", "Estado", "Filas", "snapshotTs", "Último cursor", "Último avance", "Error"].map(
              (h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "8px 12px",
                    borderBottom: "1px solid #e5e7eb",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.name} style={{ borderBottom: "1px solid #f3f4f6" }}>
              <td style={{ padding: "8px 12px", fontWeight: 600 }}>{t.name}</td>
              <td style={{ padding: "8px 12px" }}>
                <StatusBadge status={t.status} />
              </td>
              <td style={{ padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>
                {t.rowsApplied.toLocaleString()}
              </td>
              <td style={{ padding: "8px 12px", color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>
                {t.snapshotTs ?? "—"}
              </td>
              <td
                style={{
                  padding: "8px 12px",
                  color: "#6b7280",
                  fontFamily: "monospace",
                  fontSize: 11,
                }}
              >
                {fmtCursor(t.lastCursor)}
              </td>
              <td style={{ padding: "8px 12px", color: "#6b7280", whiteSpace: "nowrap" }}>
                {fmtTs(t.lastAppliedAtMs)}
              </td>
              <td
                style={{
                  padding: "8px 12px",
                  color: "#ef4444",
                  fontSize: 11,
                  maxWidth: 280,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={t.lastError}
              >
                {t.lastError ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 24 }}>
        <a href="/">← Inicio</a>
      </p>
    </main>
  );
}
