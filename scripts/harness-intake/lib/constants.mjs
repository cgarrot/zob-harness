

export const FACTORY_NAME = "harness-intake-agent-team";
export const RUNS_ROOT = "reports/factory-runs";
export const SCHEMA_PREFIX = "zob.harness-intake";
export const repoRoot = process.cwd();

export const DEFAULT_FORBIDDEN = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "secrets",
  "secret",
  "credentials",
  "tokens",
  ".ssh",
  ".aws",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "out",
];

export const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".sh",
  ".zsh",
  ".fish",
  ".py",
  ".log",
]);

export const MAX_FILE_BYTES = 320 * 1024;
export const MAX_SCAN_FILES = 1200;
export const MAX_SESSION_FILES = 200;
