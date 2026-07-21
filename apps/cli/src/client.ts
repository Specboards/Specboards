/**
 * Thin HTTP client for the Specboards `/api/v1` surface. Sends the API key as
 * the `x-api-key` header (the same surface the web UI uses). Every method
 * unwraps the `{ resource }` envelope or throws `ApiError` carrying the
 * server's `{ error }` message and status.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Me {
  mode: "workspace" | "local";
  user: { id: string; name: string; email: string } | null;
  workspace: { id: string; name: string; slug: string } | null;
  role: string | null;
}

export interface Feature {
  specId: string;
  title: string;
  level: string;
  isDbNative: boolean;
  productId: string | null;
  status: string;
  assigneeId: string | null;
  tags: string[];
  releaseId: string | null;
  parentSpecId: string | null;
  path: string;
}

export interface Product {
  id: string;
  key: string;
  name: string;
}

export interface Workflow {
  statuses: string[];
  transitions: Record<string, string[]>;
}

export type GithubLinkKind = "pull_request" | "issue" | "branch";

export interface FeaturePatch {
  status?: string;
  assigneeId?: string | null;
  title?: string;
  tags?: string[];
  releaseId?: string | null;
}

export class SpecboardsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    /** Org to scope requests to (sent as `x-org-slug`); needed for multi-org keys. */
    private readonly orgSlug?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.baseUrl.replace(/\/$/, "") + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          ...(this.orgSlug ? { "x-org-slug": this.orgSlug } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(`Could not reach ${url}: ${(err as Error).message}`, 0);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const message =
        (data as { error?: string }).error ?? `${res.status} ${res.statusText}`;
      throw new ApiError(message, res.status);
    }
    return data as T;
  }

  me(): Promise<Me> {
    return this.request<Me>("GET", "/api/v1/me");
  }

  async listFeatures(): Promise<Feature[]> {
    const { features } = await this.request<{ features: Feature[] }>(
      "GET",
      "/api/v1/features",
    );
    return features;
  }

  async getFeature(specId: string): Promise<Feature> {
    const { feature } = await this.request<{ feature: Feature }>(
      "GET",
      `/api/v1/features/${encodeURIComponent(specId)}`,
    );
    return feature;
  }

  async patchFeature(specId: string, patch: FeaturePatch): Promise<Feature> {
    const { feature } = await this.request<{ feature: Feature }>(
      "PATCH",
      `/api/v1/features/${encodeURIComponent(specId)}`,
      patch,
    );
    return feature;
  }

  async linkGithub(
    specId: string,
    input: { kind: GithubLinkKind; number?: number; branch?: string },
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/v1/features/${encodeURIComponent(specId)}/github-links`,
      input,
    );
  }

  async listProducts(): Promise<Product[]> {
    const { products } = await this.request<{ products: Product[] }>(
      "GET",
      "/api/v1/products",
    );
    return products;
  }

  /** The resolved workflow (ordered statuses + legal transitions) the server enforces. */
  async getWorkflow(): Promise<Workflow> {
    const { workflow } = await this.request<{ workflow: Workflow }>(
      "GET",
      "/api/v1/statuses",
    );
    return workflow;
  }
}
