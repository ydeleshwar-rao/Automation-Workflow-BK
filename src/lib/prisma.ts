import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// Singleton Prisma client — reuse across the app to avoid connection exhaustion.
// In development, store on globalThis to survive hot-reloads.
// Prisma v7: requires pg adapter (url removed from schema.prisma)

const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

const createPrismaClient = (): PrismaClient => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
};

const prisma: PrismaClient = globalForPrisma._prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma._prisma = prisma;
}

export default prisma;
