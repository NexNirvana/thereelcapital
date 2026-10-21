<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import ActivationLink from "#lib/ui/ActivationLink.svelte";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import ReauthButton from "#lib/ui/ReauthButton.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const admin = $derived(data.admin);

  let busy = $state(false);
  let submitFailure = $state<string | null>(null);
  let closedLink = $state<string | null>(null);
  let confirmed = $state(false);

  const failure = $derived(form && "code" in form ? form : null);
  const issued = $derived(form && "issued" in form ? form.issued : null);
  const visibleLink = $derived(issued && issued.link !== closedLink ? issued : null);
</script>

<svelte:head><title>{admin.email} · Admin · Reel Capital</title></svelte:head>

<p><a href={resolve("/admin")}>← Clientes</a></p>
<h1>{admin.email}</h1>

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
  <h2 id="profile">Administrador</h2>
  <dl>
    <DefinitionRow label="Correo" value={admin.email} />
    <DefinitionRow label="Passkeys" value={String(admin.passkeys)} />
    <DefinitionRow label="Códigos sin usar" value={String(admin.unusedCodes)} />
  </dl>
</section>

<section aria-labelledby="recovery">
  <h2 id="recovery">Recuperación controlada</h2>
  {#if admin.disabled}
    <p class="hint">El administrador está desactivado; no podría entrar con un enlace nuevo.</p>
  {:else}
    <p class="hint">
      Para un administrador que perdió su passkey y sus códigos. Cierra todas sus sesiones, elimina
      sus passkeys y sus códigos de recuperación, y genera un enlace de activación nuevo que se
      muestra una sola vez. Tú no entras como él.
    </p>
    <form
      method="POST"
      action="?/recover"
      use:enhance={() => {
        busy = true;
        confirmed = false;
        submitFailure = null;
        return async ({ result, update }) => {
          try {
            if (result.type === "error") {
              submitFailure = result.error.code
                ? result.error.message
                : "No pudimos enviar el formulario. Inténtalo de nuevo.";
              return;
            }
            await update({ reset: false });
          } finally {
            busy = false;
          }
        };
      }}
    >
      <label class="check">
        <input type="checkbox" name="verified" required />
        Verifiqué la identidad del administrador fuera de la app
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? "Recuperando" : "Iniciar recuperación"}
      </Button>
    </form>
  {/if}
</section>

<style>
  h1 {
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
</style>
