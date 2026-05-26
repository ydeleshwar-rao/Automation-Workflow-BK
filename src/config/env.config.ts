import dotenv from "dotenv";
import path from "path";
import fs from "fs";

const env = process.env.NODE_ENV || "development";

// Try to load .env.{env}, then fallback to .env.local if it exists
const envPath = path.resolve(process.cwd(), `.env.${env}`);
const localEnvPath = path.resolve(process.cwd(), ".env.local");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else {
  dotenv.config(); // Load default .env if fallback fails
}

console.log("ENV LOADED:", env);
