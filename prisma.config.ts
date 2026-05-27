import path from "node:path";
import { defineConfig } from "prisma/config";
import dotenv from "dotenv";
import fs from "node:fs";

// Load env file — mirrors env.config.ts logic
const env = process.env.NODE_ENV || "development";
const envFilePath = path.resolve(process.cwd(), `.env.${env}`);
const fallbackPath = path.resolve(process.cwd(), ".env");

if (fs.existsSync(envFilePath)) {
  dotenv.config({ path: envFilePath });
} else if (fs.existsSync(fallbackPath)) {
  dotenv.config({ path: fallbackPath });
}

export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, "prisma/schema.prisma"),
  migrate: {
    async adapter() {
      const { Pool } = await import("pg");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      // Use DIRECT_URL for migrations (bypasses pooler)
      const pool = new Pool({ connectionString: process.env.DIRECT_URL });
      return new PrismaPg(pool);
    },
  },
});
