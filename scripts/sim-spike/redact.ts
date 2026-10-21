// Redaction for everything the spike prints or saves. Secrets and tokens become "[REDACTED]" and
// account numbers keep only their last 4 characters. Values are registered as they are learned and
// replaced wherever they appear (bodies, URLs, notes); well-known keys are also masked by name.

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "client_id",
  "token",
  "authorization",
  "alias",
]);
const ACCOUNT_KEYS = new Set(["accountid", "accountnumber", "account", "accounts"]);
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const QUERY_SECRET_PATTERN = /([?&](?:code|refresh_token|access_token|client_secret)=)[^&\s"]+/g;

export const REDACTED = "[REDACTED]";

export function maskAccount(accountId: string): string {
  return `****${accountId.slice(-4)}`;
}

export class Redactor {
  readonly #secrets = new Set<string>();
  readonly #accounts = new Set<string>();

  addSecret(value: string | undefined): void {
    if (value !== undefined && value.length >= 4) this.#secrets.add(value);
  }

  addAccount(accountId: string): void {
    if (accountId.length >= 4) this.#accounts.add(accountId);
  }

  text(input: string): string {
    // Longest first, so a value that contains another one is replaced whole.
    const replacements: [string, string][] = [
      ...[...this.#secrets].map((value): [string, string] => [value, REDACTED]),
      ...[...this.#accounts].map((value): [string, string] => [value, maskAccount(value)]),
    ].sort((a, b) => b[0].length - a[0].length);
    let out = input;
    for (const [value, replacement] of replacements) out = out.replaceAll(value, replacement);
    return out.replace(JWT_PATTERN, REDACTED).replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`);
  }

  json(value: unknown, key = ""): unknown {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower) && value !== null && typeof value !== "object") return REDACTED;
    if (ACCOUNT_KEYS.has(lower) && typeof value === "string") {
      return this.text(
        value
          .split(",")
          .map((id) => maskAccount(id.trim()))
          .join(","),
      );
    }
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.json(item, key));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [this.text(name), this.json(inner, name)]),
      );
    }
    return value;
  }
}
