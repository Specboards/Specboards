import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi";

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument("https://app.specboard.ai") as {
    openapi: string;
    info: { title: string };
    servers: { url: string }[];
    components: { securitySchemes: Record<string, { type: string; name: string }> };
    paths: Record<string, Record<string, unknown>>;
  };

  it("is an OpenAPI 3 document with the deployment origin as its server", () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("Specboard API");
    expect(doc.servers[0]!.url).toBe("https://app.specboard.ai");
  });

  it("declares the x-api-key security scheme", () => {
    const scheme = doc.components.securitySchemes.ApiKeyAuth!;
    expect(scheme.type).toBe("apiKey");
    expect(scheme.name).toBe("x-api-key");
  });

  it("documents the core resources and the verbs we added this release", () => {
    expect(doc.paths["/api/v1/features"]).toHaveProperty("get");
    expect(doc.paths["/api/v1/products/{id}"]).toHaveProperty("get");
    expect(doc.paths["/api/v1/repositories/{id}"]).toHaveProperty("patch");
    expect(doc.paths["/api/v1/views/{id}"]).toHaveProperty("patch");
    expect(doc.paths["/api/v1/org/service-accounts"]).toHaveProperty("post");
    expect(doc.paths["/api/v1/statuses"]).toHaveProperty("get");
  });

  it("documents opt-in pagination on the list endpoints", () => {
    const params = (
      doc.paths["/api/v1/features"] as {
        get: { parameters: { name: string }[] };
      }
    ).get.parameters;
    expect(params.map((p) => p.name)).toEqual(["limit", "cursor"]);
  });
});
