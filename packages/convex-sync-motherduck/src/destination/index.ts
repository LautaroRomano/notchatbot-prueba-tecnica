/**
 * Punto de entrada del subpaquete `destination/`. Re-exporta tipos públicos
 * y la factory `createDuckDestination`. Cualquier consumidor del componente
 * (incluyendo las actions internas de snapshot/deltas en fases siguientes)
 * debe pasar por acá — no importar `./duck` directo, para mantener una
 * fachada estable si en el futuro agregamos otra implementación.
 */

export type {
  CellValue,
  ColumnDef,
  Destination,
  LogicalType,
  Row,
} from "./types";
export { duckSqlType } from "./types";
export {
  createDuckDestination,
  type DuckDestinationOptions,
} from "./duck";
