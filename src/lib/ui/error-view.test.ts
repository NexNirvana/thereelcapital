import { describe, expect, it } from "bun:test";
import { errorView } from "./error-view";

describe("errorView", () => {
  it("explains a missing page in Spanish", () => {
    expect(errorView(404, undefined)).toMatchObject({
      message: "No encontramos esta página.",
      code: "NOT_FOUND",
    });
  });

  it("sends a signed-out visitor to sign in", () => {
    expect(errorView(401, "AUTH_REQUIRED").signIn).toBe(true);
    expect(errorView(403, "FORBIDDEN").signIn).toBe(false);
  });

  it("never shows an internal message for a server error", () => {
    const shown = errorView(500, undefined);
    expect(shown.message).toBe(
      "Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos.",
    );
    expect(shown.code).toBe("INTERNAL_ERROR");
  });

  it("keeps a stable code from the server", () => {
    expect(errorView(400, "INVALID_EMAIL").code).toBe("INVALID_EMAIL");
  });
});
