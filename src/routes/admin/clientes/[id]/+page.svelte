<script lang="ts">
  import { enhance, type SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";
  import ActivationLink from "#lib/ui/ActivationLink.svelte";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import ReauthButton from "#lib/ui/ReauthButton.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const client = $derived(data.client);

  const access = { invited: "Invitado", active: "Activo", disabled: "Desactivado" } as const;
  const linkState = {
    none: "Sin enlace",
    open: "Vigente",
    used: "Usado",
    expired: "Vencido",
    revoked: "Revocado",
  } as const;
  const done: Record<string, string> = {
    revokeLink: "Enlace revocado.",
    deactivate: "Cliente desactivado: sus sesiones se cerraron.",
    reactivate: "Cliente reactivado.",
    revokeSession: "Sesión cerrada.",
    revokeAllSessions: "Sesiones cerradas.",
    updateSettings: "Configuración guardada.",
  };

  const usd = new Intl.NumberFormat("en-US"); // docs/design-system.md#formats: US$20,000
  const when = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  });

  let busy = $state<string | null>(null);
  let submitFailure = $state<string | null>(null);
  let closedLink = $state<string | null>(null);
  let confirmed = $state(false);

  const failure = $derived(form && "code" in form ? form : null);
  const issued = $derived(form?.issued ?? null);
  const visibleLink = $derived(issued && issued.link !== closedLink ? issued : null);
  const success = $derived(
    form && !("code" in form) && !form.issued ? (done[form.action] ?? null) : null,
  );

  const submit =
    (name: string): SubmitFunction =>
    () => {
      busy = name;
      confirmed = false;
      submitFailure = null;
      return async ({ result, update }) => {
        try {
          // A refused or unreachable request is not a form result: say so instead of waiting.
          if (result.type === "error") {
            submitFailure = result.error.code
              ? result.error.message
              : "No pudimos enviar el formulario. Inténtalo de nuevo.";
            return;
          }
          await update({ reset: false });
        } finally {
          busy = null;
        }
      };
    };
</script>

<svelte:head><title>{client.email} · Admin · Reel Capital</title></svelte:head>

<p><a href={resolve("/admin")}>← Clientes</a></p>
<h1>{client.email}</h1>

<div class="messages" aria-live="polite">
  {#if submitFailure}
    <Notice title="No pudimos enviar el formulario" role="alert">{submitFailure}</Notice>
  {/if}
  {#if failure && confirmed}
    <Notice title="Identidad confirmada">Repite la acción.</Notice>
  {:else if failure}
    <Notice title="No se aplicó el cambio" role="alert">{failure.message}</Notice>
    {#if failure.code === "REAUTH_REQUIRED"}
      <ReauthButton onconfirmed={() => (confirmed = true)} />
    {/if}
  {/if}
  {#if success && !failure}<Notice title={success} />{/if}
  {#if visibleLink}
    {#key visibleLink.link}
      <ActivationLink
        title="Nuevo enlace de activación"
        link={visibleLink.link}
        expiresAt={visibleLink.expiresAt}
        onhide={() => (closedLink = visibleLink.link)}
      />
    {/key}
  {/if}
</div>

<section aria-labelledby="profile">
  <h2 id="profile">Perfil</h2>
  <dl>
    <DefinitionRow label="Correo" value={client.email} />
    <DefinitionRow label="Nombre" value={client.name} />
    <DefinitionRow label="Rol" value="Cliente" />
    <DefinitionRow label="Acceso" value={access[client.access]} />
    <DefinitionRow label="Passkeys" value={String(client.passkeys)} />
    <DefinitionRow label="Códigos de recuperación sin usar" value={String(client.unusedCodes)} />
  </dl>
</section>

<section aria-labelledby="access">
  <h2 id="access">Acceso</h2>
  {#if client.access === "disabled"}
    <p class="hint">
      El cliente no puede iniciar sesión. Sus órdenes en el broker no se tocan al desactivarlo.
    </p>
    <form method="POST" action="?/reactivate" use:enhance={submit("reactivate")}>
      <Button type="submit" disabled={busy !== null}>
        {busy === "reactivate" ? "Reactivando" : "Reactivar cliente"}
      </Button>
    </form>
  {:else}
    <p class="hint">
      Desactivar cierra todas sus sesiones y bloquea el inicio de sesión. Sus órdenes en el broker
      no se tocan.
    </p>
    <form method="POST" action="?/deactivate" use:enhance={submit("deactivate")}>
      <Button type="submit" disabled={busy !== null}>
        {busy === "deactivate" ? "Desactivando" : "Desactivar cliente"}
      </Button>
    </form>
  {/if}
</section>

<section aria-labelledby="link">
  <h2 id="link">Enlace de activación</h2>
  <dl>
    <DefinitionRow label="Estado" value={linkState[client.link.state]} />
    {#if client.link.expiresAt !== null && client.link.state === "open"}
      <DefinitionRow label="Vence" value="{when.format(client.link.expiresAt)} ET" />
    {/if}
  </dl>
  {#if client.access === "disabled"}
    <p class="hint">Reactiva al cliente para generar un enlace.</p>
  {:else if client.passkeys > 0}
    <p class="hint">
      El cliente ya tiene passkey. Para devolverle el acceso usa la recuperación controlada.
    </p>
  {:else}
    <p class="hint">Un enlace nuevo invalida el anterior. El enlace no se vuelve a mostrar.</p>
    <div class="actions">
      <form method="POST" action="?/generateLink" use:enhance={submit("generateLink")}>
        <Button type="submit" disabled={busy !== null}>
          {busy === "generateLink" ? "Generando enlace" : "Generar enlace nuevo"}
        </Button>
      </form>
      {#if client.link.state === "open"}
        <form method="POST" action="?/revokeLink" use:enhance={submit("revokeLink")}>
          <Button type="submit" disabled={busy !== null}>Revocar enlace</Button>
        </form>
      {/if}
    </div>
  {/if}
</section>

<section aria-labelledby="sessions">
  <h2 id="sessions">Sesiones</h2>
  {#if client.sessions.length === 0}
    <p class="hint">No hay sesiones abiertas.</p>
  {:else}
    <!-- A scrollable table must be reachable by keyboard. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" role="region" aria-labelledby="sessions" tabindex="0">
      <table>
        <thead>
          <tr>
            <th scope="col">Tipo</th><th scope="col">Inicio</th><th scope="col">Vence</th>
            <th scope="col">Navegador</th><th scope="col"><span class="sr">Acción</span></th>
          </tr>
        </thead>
        <tbody>
          {#each client.sessions as session (session.id)}
            <tr>
              <th scope="row">{session.enrollment ? "Solo registro" : "Completa"}</th>
              <td data-label="Inicio">{when.format(session.createdAt)}</td>
              <td data-label="Vence">{when.format(session.expiresAt)}</td>
              <td data-label="Navegador" class="agent">{session.userAgent ?? "Desconocido"}</td>
              <td>
                <form method="POST" action="?/revokeSession" use:enhance={submit("revokeSession")}>
                  <input type="hidden" name="sessionId" value={session.id} />
                  <Button type="submit" disabled={busy !== null}>Cerrar sesión</Button>
                </form>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <form method="POST" action="?/revokeAllSessions" use:enhance={submit("revokeAllSessions")}>
      <Button type="submit" disabled={busy !== null}>Cerrar todas las sesiones</Button>
    </form>
  {/if}
</section>

<section aria-labelledby="recovery">
  <h2 id="recovery">Recuperación controlada</h2>
  {#if client.access === "disabled"}
    <p class="hint">Reactiva al cliente para iniciar su recuperación.</p>
  {:else}
    <p class="hint">
      Para un cliente que perdió su passkey y sus códigos. Cierra todas sus sesiones, elimina sus
      passkeys y sus códigos de recuperación, y genera un enlace de activación nuevo que se muestra
      una sola vez. Tú no entras como el cliente.
    </p>
    <form method="POST" action="?/recover" use:enhance={submit("recover")}>
      <label class="check">
        <input type="checkbox" name="verified" required />
        Verifiqué la identidad del cliente fuera de la app
      </label>
      <Button type="submit" disabled={busy !== null}>
        {busy === "recover" ? "Recuperando" : "Iniciar recuperación"}
      </Button>
    </form>
  {/if}
</section>

<section aria-labelledby="settings">
  <h2 id="settings">Configuración</h2>
  {#if client.settings === null}
    <p class="hint">Este cliente no tiene configuración guardada.</p>
  {:else}
    <p class="hint">
      Los cambios valen solo para nuevas entradas y posiciones nuevas. Las posiciones abiertas
      conservan los valores con los que se abrieron.
    </p>
    <form method="POST" action="?/updateSettings" use:enhance={submit("updateSettings")}>
      <div class="field">
        <label for="sizeUsd">SIZE por entrada (USD)</label>
        <input
          id="sizeUsd"
          name="sizeUsd"
          type="number"
          inputmode="numeric"
          min={client.settings.sizeUsd}
          step="1"
          required
          aria-describedby="sizeUsd-hint"
          value={client.settings.sizeUsd}
        />
        <span id="sizeUsd-hint" class="hint">
          Actual US${usd.format(client.settings.sizeUsd)}. Solo puede aumentar; solo nuevas
          entradas.
        </span>
      </div>
      <div class="field">
        <label for="stopPct">Stop inicial (%)</label>
        <input
          id="stopPct"
          name="stopPct"
          type="number"
          inputmode="numeric"
          min={client.bounds.stopPct.min}
          max={client.bounds.stopPct.max}
          step="1"
          required
          aria-describedby="stopPct-hint"
          value={client.settings.stopPct}
        />
        <span id="stopPct-hint" class="hint">
          Entre {client.bounds.stopPct.min} y {client.bounds.stopPct.max}. Debajo del precio
          promedio de compra; solo posiciones nuevas.
        </span>
      </div>
      <div class="field">
        <label for="unlockPct">Desbloqueo del trailing (%)</label>
        <input
          id="unlockPct"
          name="unlockPct"
          type="number"
          inputmode="numeric"
          min={client.bounds.unlockPct.min}
          max={client.bounds.unlockPct.max}
          step="1"
          required
          aria-describedby="unlockPct-hint"
          value={client.settings.trailingUnlockPct}
        />
        <span id="unlockPct-hint" class="hint">
          Entre {client.bounds.unlockPct.min} y {client.bounds.unlockPct.max}. Porcentaje de la
          cantidad original vendido para activar el trailing; solo posiciones nuevas.
        </span>
      </div>
      <Button type="submit" disabled={busy !== null}>
        {busy === "updateSettings" ? "Guardando" : "Guardar configuración"}
      </Button>
    </form>
  {/if}
  <h3>Límites</h3>
  <p class="hint">Fijos para todos los clientes; solo lectura.</p>
  <dl>
    <DefinitionRow label="Posiciones abiertas" value={`máx. ${client.limits.openPositions}`} />
    <DefinitionRow
      label="Entradas por día de mercado"
      value={`máx. ${client.limits.dailyEntries}`}
    />
  </dl>
</section>

<section aria-labelledby="operations">
  <h2 id="operations">Conexión y posiciones</h2>
  <!-- TODO(#35): connection status, open positions and orders. -->
  <p class="hint">Disponible próximamente.</p>
</section>

<style>
  h1 {
    /* An email is read as typed; the global uppercase makes it hard to scan. */
    text-transform: none;
    font-size: clamp(22px, 4vw, 32px);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 2.5rem 0 0.75rem;
    font-size: 1.125rem;
  }
  p {
    margin: 0 0 0.75rem;
  }
  p a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text-muted);
  }
  .hint {
    max-width: 40rem;
    color: var(--text-muted);
  }
  .messages,
  section > form {
    display: grid;
    gap: 0.75rem;
    max-width: 40rem;
  }
  .messages {
    margin-top: 1rem;
  }
  dl {
    max-width: 40rem;
    margin: 0 0 1rem;
    border-top: 1px solid var(--rule);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  label {
    color: var(--text-muted);
  }
  h3 {
    margin: 1.5rem 0 0.5rem;
    font-size: 1rem;
  }
  .field {
    display: grid;
    gap: 0.5rem;
  }
  .field input {
    min-height: var(--target);
    padding: 0 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  .field .hint {
    font-size: 0.875rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--target);
    color: var(--text);
  }
  .check input {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: var(--text);
  }
  .scroll {
    margin-bottom: 1rem;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 0.75rem 1rem 0.75rem 0;
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
  .agent {
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  /* docs/design-system.md#layout-shell: on a phone each session is one stacked row. */
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
    }
    td {
      color: var(--text-muted);
    }
    td[data-label]::before {
      content: attr(data-label) ": ";
    }
    .agent {
      max-width: none;
      flex-basis: 100%;
      overflow-wrap: anywhere;
    }
    tr td:last-child {
      flex-basis: 100%;
    }
  }
</style>
