"use client";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1, the same surface external integrations use, so the browser
 * never talks to anything but the versioned API.
 *
 * This file is the compatibility entry point. The implementation lives in the
 * focused modules re-exported below, so existing `@/lib/api-client` imports
 * keep working; prefer importing from the module that owns the call.
 */

export { AuthRequiredError } from "@/lib/api-client/request";
export * from "@/lib/api-client/assistant";
export * from "@/lib/api-client/docs";
export * from "@/lib/api-client/ideas";
export * from "@/lib/api-client/notifications";
export * from "@/lib/api-client/organization";
export * from "@/lib/api-client/planning";
export * from "@/lib/api-client/products";
export * from "@/lib/api-client/repositories";
export * from "@/lib/api-client/specs";
export * from "@/lib/api-client/views";
export * from "@/lib/api-client/work-items";
export * from "@/lib/api-client/workspace-config";
