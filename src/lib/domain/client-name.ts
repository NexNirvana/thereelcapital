// D39 (docs/decisions.md): the name is the one profile field an admin edits. Clients are created
// with their e-mail as name, so the limit leaves room for any e-mail address (254 characters).
export const CLIENT_NAME_MAX_CHARS = 254;

// Control characters (tabs, newlines, DEL) have no place in a name shown in tables and audit rows.
const CONTROL_CHARS = /\p{Cc}/u;

/** The trimmed name, or null when it is empty, too long or holds control characters. */
export function normalizeClientName(input: string): string | null {
  const name = input.trim();
  if (name === "" || name.length > CLIENT_NAME_MAX_CHARS || CONTROL_CHARS.test(name)) return null;
  return name;
}
