import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI configuration: where the Specboards deployment lives and the API key to
 * authenticate with. Stored at ~/.specboards/config.json (override the whole
 * path with SPECBOARDS_CONFIG). Environment variables SPECBOARDS_URL and
 * SPECBOARDS_TOKEN take precedence over the file, so CI can run keyless of disk.
 */
export interface CliConfig {
  baseUrl?: string;
  apiKey?: string;
  /**
   * Which organization to act in, by slug. Only needed when the key's user
   * belongs to more than one org; the server rejects an ambiguous request
   * otherwise. Env `SPECBOARDS_ORG` overrides the file.
   */
  orgSlug?: string;
}

export function configPath(): string {
  return process.env.SPECBOARDS_CONFIG ?? join(homedir(), ".specboards", "config.json");
}

export function loadFileConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function saveFileConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function clearFileConfig(): void {
  try {
    rmSync(configPath());
  } catch {
    /* already gone */
  }
}

/** The effective config: env overrides file. */
export function resolveConfig(): CliConfig {
  const file = loadFileConfig();
  return {
    baseUrl: process.env.SPECBOARDS_URL ?? file.baseUrl,
    apiKey: process.env.SPECBOARDS_TOKEN ?? file.apiKey,
    orgSlug: process.env.SPECBOARDS_ORG ?? file.orgSlug,
  };
}
