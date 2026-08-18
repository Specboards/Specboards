export * from "./schema.js";
export * from "./client.js";
export * from "./rls-probe.js";
// Re-export query operators so consumers never import drizzle-orm directly
// (a second drizzle instance, e.g. via better-auth's peer deps, makes the
// types nominally incompatible).
export { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, not, or, sql } from "drizzle-orm";
// Same reason: joining one table twice needs an alias, and reaching into
// drizzle-orm for it in an app file is how the second-instance type mismatch
// gets in.
export { alias } from "drizzle-orm/pg-core";
