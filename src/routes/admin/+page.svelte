<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { connectionLabel } from "#lib/ui/admin-operations.ts";
  import Button from "#lib/ui/Button.svelte";
  import ActivationLink from "#lib/ui/ActivationLink.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import ReauthButton from "#lib/ui/ReauthButton.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const access = { invited: "Invitado", active: "Activo", disabled: "Desactivado" } as const;

  let creating = $state(false);
  let submitFailure = $state<string | null>(null);
  let closedLink = $state<string | null>(null);
  let confirmed = $state(false);

  const created = $derived(form && "created" in form ? form.created : null);
  const failure = $derived(form && "code" in form ? form : null);
  const visibleLink = $derived(created && created.link !== closedLink ? created : null);
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
          <ReauthButton onconfirmed={() => (confirmed = true)} />
        {/if}
      </div>
    {/if}
    {#if visibleLink}
      {#key visibleLink.link}
        <ActivationLink
          title="Cliente creado: {visibleLink.email}"
          link={visibleLink.link}
          expiresAt={visibleLink.expiresAt}
          onhide={() => (closedLink = visibleLink.link)}
        />
      {/key}
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
              <th scope="row">
                <a href={resolve("/admin/clientes/[id]", { id: client.id })}>{client.email}</a>
              </th>
              <td data-label="Acceso">{access[client.access]}</td>
              <td data-label="Conexión" aria-live="polite">
                {#if typeof client.connection === "string"}
                  {connectionLabel(client.connection)}
                {:else}
                  {#await client.connection}
                    <span class="pending">Cargando…</span>
                  {:then connection}
                    {connectionLabel(connection)}
                  {/await}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

{#if data.admins.length > 0}
  <section aria-labelledby="admin-list">
    <h2 id="admin-list">Otros administradores</h2>
    <ul class="admins">
      {#each data.admins as admin (admin.id)}
        <li>
          <a href={resolve("/admin/administradores/[id]", { id: admin.id })}>{admin.email}</a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

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
  .scroll {
    overflow-x: auto;
  }
  .pending {
    color: var(--text-muted);
  }
  .admins {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .admins a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text);
    overflow-wrap: anywhere;
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
  tbody th a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text);
  }

  /* docs/design-system.md#layout-shell: on a phone each client is one stacked row, so the email
     wraps and the status columns are never scrolled out of sight. */
  @media (max-width: 600px) {
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
      flex-basis: 100%;
      color: var(--text-muted);
    }
    td::before {
      content: attr(data-label) ": ";
    }
  }
</style>
