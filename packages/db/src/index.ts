export * from "./schema.js";
export * from "./client.js";
// Re-export query operators so consumers never import drizzle-orm directly
// (a second drizzle instance, e.g. via better-auth's peer deps, makes the
// types nominally incompatible).
export { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
