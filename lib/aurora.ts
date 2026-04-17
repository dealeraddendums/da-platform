// Server-only: Aurora MySQL connection pool.
// Import from this file only in API routes and server components — NOT in client components.
// For shared types and helpers, import from @/lib/vehicles instead.

import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { VehicleRow } from "@/lib/vehicles";

export type { VehicleRow };

// Re-export helpers so API routes only need one import
export { parsePhotos, parseOptions, vehicleCondition } from "@/lib/vehicles";

// RowDataPacket intersection for internal mysql2 query typing
export type VehicleRowPacket = VehicleRow & RowDataPacket;

// ── Connection pool singleton ─────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __auroraPool: Pool | undefined;
}

function createPool(): Pool {
  return mysql.createPool({
    host: process.env.AURORA_HOST,
    user: process.env.AURORA_USER,
    password: process.env.AURORA_PASSWORD,
    database: process.env.AURORA_DATABASE,
    port: parseInt(process.env.AURORA_PORT ?? "3306", 10),
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10_000,
    enableKeepAlive: true,
  });
}

export function getPool(): Pool {
  if (!global.__auroraPool) {
    global.__auroraPool = createPool();
  }
  return global.__auroraPool;
}
