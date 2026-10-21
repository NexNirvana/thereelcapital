<script lang="ts">
  import { resolve } from "$app/paths";
  import { authClient } from "#lib/auth-client.ts";
  import {
    enrollmentLost,
    finishEnrollmentErrorMessage,
    passkeyRegistrationErrorMessage,
  } from "#lib/auth-messages.ts";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";

  // The two steps both ways in share (recovery code, activation link): register a passkey inside
  // the enrollment session, then show the new recovery codes once. The server decides everything
  // (docs/auth-and-security.md#flows); this component sends the confirmation and shows the outcome.
  let {
    way,
    onlost,
    onfinish,
  }: {
    /** Only the wording differs: recovery replaces a lost passkey, activation registers the first. */
    way: "recovery" | "activation";
    /** The enrollment session is gone, so the parent starts over with its own first step. */
    onlost: () => void;
    /** The client saved the codes; they are dropped from memory before this runs. */
    onfinish: () => void | Promise<void>;
  } = $props();

  let step = $state<"passkey" | "codes">("passkey");
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let codes = $state<string[]>([]);
  let copied = $state(false);
  // Registration succeeded but finishing failed: a retry must finish, not register a second passkey.
  let passkeyRegistered = $state(false);

  const copy = {
    recovery: {
      title: ["Registra tu", "nueva passkey."],
      lead: "Cerramos tus sesiones anteriores. Tienes 15 minutos para registrar una passkey nueva con huella, rostro o PIN.",
      codes:
        "Estos son tus nuevos códigos de recuperación. Se muestran una sola vez y los anteriores ya no sirven.",
    },
    activation: {
      title: ["Registra tu", "passkey."],
      lead: "Es tu llave de acceso: sin contraseña, con huella, rostro o PIN. Tienes 15 minutos para registrarla.",
      codes:
        "Estos son tus códigos de recuperación. Se muestran una sola vez; guárdalos en un lugar seguro.",
    },
  } as const;
  const words = $derived(copy[way]);

  const codeOf = (error: object) =>
    "code" in error && typeof error.code === "string" ? error.code : undefined;

  async function registerPasskey() {
    pending = true;
    failure = null;
    if (!passkeyRegistered) {
      const registered = await authClient.passkey.addPasskey();
      if (registered?.error) {
        pending = false;
        if (enrollmentLost(codeOf(registered.error), registered.error.status)) return onlost();
        failure = passkeyRegistrationErrorMessage(codeOf(registered.error));
        return;
      }
      passkeyRegistered = true;
    }
    const { data: done, error } = await authClient.$fetch<{ codes: string[] }>(
      "/enrollment/complete",
      { method: "POST", body: {} },
    );
    pending = false;
    if (error || !done) {
      if (error && enrollmentLost(codeOf(error), error.status)) return onlost();
      failure = finishEnrollmentErrorMessage(error && codeOf(error), error?.status);
      return;
    }
    codes = done.codes;
    step = "codes";
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      copied = true;
    } catch {
      copied = false;
    }
  }

  async function finish() {
    // The codes leave the page's memory with it; nothing is stored in the browser.
    codes = [];
    await onfinish();
  }
</script>

{#if step === "passkey"}
  <h1>{words.title[0]}<br />{words.title[1]}</h1>
  <p class="lead">{words.lead}</p>
  <Button variant="primary" onclick={registerPasskey} disabled={pending}>
    {pending ? "Esperando tu passkey" : "Crear passkey"}
  </Button>
{:else}
  <h1>Guarda tus<br />códigos.</h1>
  <p class="lead">{words.codes}</p>
  <ul class="codes" aria-label="Códigos de recuperación">
    {#each codes as recoveryCode (recoveryCode)}
      <li>{recoveryCode}</li>
    {/each}
  </ul>
  <div class="actions">
    <Button variant="outline" onclick={copyCodes}>Copiar códigos</Button>
    <span class="copied" role="status">{copied ? "Códigos copiados." : ""}</span>
    <Button variant="primary" onclick={finish}>Ya los guardé</Button>
  </div>
{/if}

<div class="failure" aria-live="assertive">
  {#if failure}<Notice title="No pudimos continuar" role="alert">{failure}</Notice>{/if}
</div>

{#if step === "passkey"}
  <a class="back" href={resolve("/acceso")}>Volver al acceso</a>
{/if}

<style>
  h1 {
    font-size: clamp(2rem, 8vw, 3.5rem);
    line-height: 1;
    margin-bottom: 1.5rem;
  }
  .lead {
    margin: 0 0 2rem;
    color: var(--text-muted);
    font-size: 1.0625rem;
  }
  .codes {
    margin: 0 0 2rem;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--rule);
  }
  .codes li {
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: 1.0625rem;
    letter-spacing: 0.04em;
    user-select: all;
  }
  .actions {
    display: grid;
    gap: 0.75rem;
  }
  .copied {
    min-height: 1.5rem;
    color: var(--text-muted);
  }
  .failure {
    margin-top: 1rem;
  }
  .back {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    margin-top: 1rem;
    color: var(--text-muted);
    text-underline-offset: 4px;
  }
</style>
