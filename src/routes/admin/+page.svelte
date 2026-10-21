<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { authClient } from "#lib/auth-client.ts";
  import { passkeyErrorMessage } from "#lib/auth-messages.ts";
  import Button from "#lib/ui/Button.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const access = { invited: "Invitado", active: "Activo", disabled: "Desactivado" } as const;
  // TODO(#35): the connection states are defined with the connection screen; until then a row
  // in broker_connection means the client has connected.
  const connection = ["Sin conectar", "Conectada"] as const;

  const expiry = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  });

  let creating = $state(false);
  let copied = $state(false);
  let copyFailed = $state(false);
  let submitFailure = $state<string | null>(null);
  let closedLink = $state<string | null>(null);
  let reauthenticating = $state(false);
  let confirmed = $state(false);
  let reauthFailure = $state<string | null>(null);

  const created = $derived(form && "created" in form ? form.created : null);
  const failure = $derived(form && "code" in form ? form : null);
  const visibleLink = $derived(created && created.link !== closedLink ? created : null);

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      copyFailed = false;
    } catch {
      copied = false;
      copyFailed = true;
    }
  }

  // A new passkey sign-in makes the session fresh again; the admin then sends the form again.
  async function confirmIdentity() {
    reauthenticating = true;
    reauthFailure = null;
    const { error } = await authClient.signIn.passkey();
    reauthenticating = false;
    if (error) {
      reauthFailure = passkeyErrorMessage("code" in error ? error.code : undefined);
      return;
    }
    confirmed = true;
    await invalidateAll();
  }
</script>

<svelte:head><title>Clientes · Admin · Reel Capital</title></svelte:head>

<h1>Clientes</h1>

<section aria-labelledby="new-client">
  <h2 id="new-client">Nuevo cliente</h2>
  <form
    method="POST"
    action="?/create"
    use:enhance={() => {
      creating = true;
      copied = false;
      copyFailed = false;
      confirmed = false;
      submitFailure = null;
      return async ({ result, update }) => {
        try {
          // A refused or unreachable request is not a form result: say so instead of leaving the
          // admin waiting, and keep what they typed.
          if (result.type === "error") {
            // Only errors with a stable code carry a Spanish message; SvelteKit's own are English.
            submitFailure = result.error.code
              ? result.error.message
              : "No pudimos enviar el formulario. Inténtalo de nuevo.";
            return;
          }
          await update();
        } finally {
          creating = false;
        }
      };
    }}
  >
    <label for="email">Correo del cliente</label>
    <input
      id="email"
      name="email"
      type="email"
      required
      autocomplete="off"
      spellcheck="false"
      aria-describedby={failure && !confirmed ? "create-failure" : undefined}
      aria-invalid={failure?.code === "INVALID_EMAIL" || failure?.code === "EMAIL_TAKEN"}
    />
    <Button variant="primary" type="submit" disabled={creating}>
      {creating ? "Creando cliente" : "Crear cliente"}
    </Button>
  </form>

  <div class="messages" aria-live="polite">
    {#if submitFailure}
      <Notice title="No pudimos enviar el formulario" role="alert">{submitFailure}</Notice>
    {/if}
    {#if failure && confirmed}
      <Notice title="Identidad confirmada"
        >Envía el formulario de nuevo para crear el cliente.</Notice
      >
    {:else if failure}
      <div id="create-failure">
        <Notice title="No se creó el cliente" role="alert">{failure.message}</Notice>
        {#if failure.code === "REAUTH_REQUIRED"}
          <Button onclick={confirmIdentity} disabled={reauthenticating}>
            {reauthenticating ? "Esperando tu passkey" : "Confirmar con passkey"}
          </Button>
          {#if reauthFailure}<Notice title="No pudimos confirmar" role="alert"
              >{reauthFailure}</Notice
            >{/if}
        {/if}
      </div>
    {/if}
    {#if visibleLink}
      <Notice title="Cliente creado: {visibleLink.email}">
        Comparte este enlace personalmente; no enviamos correos. Se muestra una sola vez y vence el
        {expiry.format(visibleLink.expiresAt)} ET.
      </Notice>
      <label for="activation-link">Enlace de activación</label>
      <div class="copy">
        <input
          id="activation-link"
          type="text"
          readonly
          value={visibleLink.link}
          onfocus={(event) => event.currentTarget.select()}
        />
        <Button onclick={() => copyLink(visibleLink.link)}>
          {copied ? "Copiado" : "Copiar enlace"}
        </Button>
      </div>
      {#if copyFailed}
        <Notice title="No se copió el enlace" role="alert">
          Selecciona el enlace del campo y cópialo a mano; no volverá a mostrarse.
        </Notice>
      {/if}
      <Button variant="link" onclick={() => (closedLink = visibleLink.link)}>
        Ya lo copié, ocultar
      </Button>
    {/if}
  </div>
</section>

<section aria-labelledby="client-list">
  <h2 id="client-list">Todos los clientes</h2>
  {#if data.clients.length === 0}
    <Notice title="Aún no hay clientes">Crea el primero con el formulario de arriba.</Notice>
  {:else}
    <!-- A scrollable table must be reachable by keyboard. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" role="region" aria-labelledby="client-list" tabindex="0">
      <table>
        <thead>
          <tr
            ><th scope="col">Correo</th><th scope="col">Acceso</th><th scope="col">Conexión</th></tr
          >
        </thead>
        <tbody>
          {#each data.clients as client (client.id)}
            <tr>
              <th scope="row">{client.email}</th>
              <td data-label="Acceso">{access[client.access]}</td>
              <td data-label="Conexión">{connection[client.hasConnection]}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  h1 {
    font-size: clamp(28px, 4vw, 40px);
  }
  h2 {
    margin: 2.5rem 0 0.75rem;
    font-size: 1.125rem;
  }
  form,
  .messages {
    display: grid;
    gap: 0.75rem;
    max-width: 32rem;
  }
  .messages {
    margin-top: 1rem;
  }
  label {
    color: var(--text-muted);
  }
  input {
    min-height: var(--target);
    padding: 0 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  input[aria-invalid="true"] {
    border: 2px solid var(--text);
  }
  .copy {
    display: flex;
    gap: 0.75rem;
  }
  .copy input {
    flex: 1;
    min-width: 0;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 1rem 1rem 1rem 0;
    border-bottom: 1px solid var(--rule);
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    color: var(--text-muted);
    font-weight: 400;
  }
  tbody th {
    font-weight: 500;
  }

  /* docs/design-system.md#layout-shell: on a phone each client is one stacked row, so the email
     wraps and the status columns are never scrolled out of sight. */
  @media (max-width: 600px) {
    .copy {
      flex-direction: column;
    }
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1.5rem;
      padding: 1rem 0;
      border-bottom: 1px solid var(--rule);
    }
    th,
    td {
      padding: 0;
      border: 0;
      white-space: normal;
    }
    tbody th {
      flex-basis: 100%;
      overflow-wrap: anywhere;
    }
    td {
      color: var(--text-muted);
    }
    td::before {
      content: attr(data-label) ": ";
    }
  }
</style>
