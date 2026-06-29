import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI configuration: where the SpecBoard deployment lives and the API key to
 * authenticate with. Stored at ~/.specboard/config.json (override the whole
 * path with SPECBOARD_CONFIG). Environment variables SPECBOARD_URL and
 * SPECBOARD_TOKEN take precedence over the file, so CI can run keyless of disk.
 */
export interface CliConfig {
  baseUrl?: string;
  apiKey?: string;
}

export function configPath(): string {
  return process.env.SPECBOARD_CONFIG ?? join(homedir(), ".specboard", "config.json");
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
    baseUrl: process.env.SPECBOARD_URL ?? file.baseUrl,
    apiKey: process.env.SPECBOARD_TOKEN ?? file.apiKey,
  };
}
