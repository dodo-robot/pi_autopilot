const REDACTED = "[REDACTED]";

/**
 * Environment variable name fragments that mark a value as sensitive
 * regardless of its own shape (a GitHub token stored under a plain-looking
 * name, an API key, etc.). Matched case-insensitively against object keys.
 */
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|credential|auth/i;

/**
 * Value shapes that are sensitive on their own, independent of the key
 * they were found under: GitHub personal/OAuth/fine-grained tokens, GitHub
 * App/installation/refresh tokens, and generic bearer-scheme headers.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
];

function redactString(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Recursively redact secret-shaped values (GitHub tokens, bearer headers)
 * and values under sensitive-looking keys (`token`, `secret`, `password`,
 * `apiKey`, `credential`, `auth*`) from an arbitrary JSON-like structure.
 * Used before any operator-facing output (e.g. `inspect`) is printed, so a
 * leaked environment variable or embedded credential in captured
 * stdout/stderr never reaches the terminal or a `--json` payload.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      result[key] = redact(entry);
    }
    return result;
  }
  return value;
}
