import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./src/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://gml:dev-only-change-me@localhost:5432/gml_lms",
  },
  strict: true,
  verbose: true,
});
