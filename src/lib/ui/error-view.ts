// What the error page says. The text depends only on the status, so no internal message or stack
// ever reaches the screen; a guard's stable `code` is passed through when there is one.

export interface ErrorView {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  /** A signed-out visitor goes to the access screen; everyone else back to Operar. */
  readonly signIn: boolean;
}

export function errorView(status: number, code: string | undefined): ErrorView {
  switch (status) {
    case 401:
      return {
        title: "Inicia sesión",
        message: "Inicia sesión para continuar.",
        code: code ?? "AUTH_REQUIRED",
        signIn: true,
      };
    case 403:
      return {
        title: "Sin acceso",
        message: "No tienes acceso a este recurso.",
        code: code ?? "FORBIDDEN",
        signIn: false,
      };
    case 404:
      return {
        title: "No encontrada",
        message: "No encontramos esta página.",
        code: code ?? "NOT_FOUND",
        signIn: false,
      };
    default:
      return status >= 500
        ? {
            title: "Algo salió mal",
            message: "Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos.",
            code: code ?? "INTERNAL_ERROR",
            signIn: false,
          }
        : {
            title: "No se pudo completar",
            message: "No pudimos procesar la solicitud.",
            code: code ?? "BAD_REQUEST",
            signIn: false,
          };
  }
}
