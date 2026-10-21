<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { authClient } from "#lib/auth-client.ts";
  import {
    enrollmentLost,
    passkeyRegistrationErrorMessage,
    recoveryErrorMessage,
    recoveryErrors,
  } from "#lib/auth-messages.ts";
  import Button from "#lib/ui/Button.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // The server decides every step (docs/auth-and-security.md#flows); the page sends what the
  // client typed or confirmed and shows the outcome.
  // Only the first value matters: the steps drive it afterwards.
  // svelte-ignore state_referenced_locally
  let step = $state<"code" | "passkey" | "codes">(data.enrolling ? "passkey" : "code");
  let code = $state("");
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let codes = $state<string[]>([]);
  let copied = $state(false);
  // Registration succeeded but finishing failed: a retry must finish, not register a second passkey.
  let passkeyRegistered = $state(false);

  const codeOf = (error: object) =>
    "code" in error && typeof error.code === "string" ? error.code : undefined;

  async function redeem(event: SubmitEvent) {
    event.preventDefault();
    pending = true;
    failure = null;
    const { error } = await authClient.$fetch("/recovery/redeem", {
      method: "POST",
      body: { code },
    });
    pending = false;
    if (error) {
      failure = recoveryErrorMessage(codeOf(error), error.status);
      return;
    }
    code = "";
    step = "passkey";
  }

  // The 15-minute enrollment session is gone: the only way forward is a new recovery code.
  function startOver() {
    failure = recoveryErrors.enrollmentExpired.message;
    passkeyRegistered = false;
    step = "code";
  }

  async function registerPasskey() {
    pending = true;
    failure = null;
    if (!passkeyRegistered) {
      const registered = await authClient.passkey.addPasskey();
      if (registered?.error) {
        pending = false;
        if (enrollmentLost(codeOf(registered.error), registered.error.status)) return startOver();
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
      if (error && enrollmentLost(codeOf(error), error.status)) return startOver();
      failure = recoveryErrorMessage(error && codeOf(error), error?.status);
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
    await invalidateAll();
    await goto(resolve("/(app)"));
  }
</script>

<svelte:head><title>Recuperación · Reel Capital</title></svelte:head>

<div class="recovery">
  <header>
    <span class="wordmark">REEL<br class="desktop-only" /> CAPITAL</span>
    <span class="private desktop-only">Acceso privado</span>
  </header>

  <main>
    {#if step === "code"}
      <h1>Recupera<br />tu acceso.</h1>
      <p class="lead">
        Ingresa uno de tus códigos de recuperación. Cada código se usa una sola vez.
      </p>
      <form onsubmit={redeem}>
        <label for="code">Código de recuperación</label>
        <input
          id="code"
          name="code"
          bind:value={code}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          required
        />
        <Button variant="primary" type="submit" disabled={pending || code.trim() === ""}>
          {pending ? "Verificando" : "Continuar"}
        </Button>
      </form>
    {:else if step === "passkey"}
      <h1>Registra tu<br />nueva passkey.</h1>
      <p class="lead">
        Cerramos tus sesiones anteriores. Tienes 15 minutos para registrar una passkey nueva con
        huella, rostro o PIN.
      </p>
      <Button variant="primary" onclick={registerPasskey} disabled={pending}>
        {pending ? "Esperando tu passkey" : "Crear passkey"}
      </Button>
    {:else}
      <h1>Guarda tus<br />códigos.</h1>
      <p class="lead">
        Estos son tus nuevos códigos de recuperación. Se muestran una sola vez y los anteriores ya
        no sirven.
      </p>
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

    {#if step !== "codes"}
      <a class="back" href={resolve("/acceso")}>Volver al acceso</a>
    {/if}
  </main>

  <footer>
    <small>thereelcapital.com</small>
    <small class="desktop-only">REEL CAPITAL</small>
  </footer>
</div>

<style>
  .recovery {
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 100dvh;
    padding: 1.5rem clamp(1rem, 4vw, 3rem);
  }
  header,
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-muted);
  }
  .wordmark {
    line-height: 1.05;
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  main {
    align-self: center;
    width: min(100%, 32rem);
    margin-inline: clamp(0rem, 7vw, 6rem) auto;
    padding: 3rem 0;
  }
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
  form {
    display: grid;
    gap: 0.75rem;
  }
  label {
    color: var(--text-muted);
  }
  input {
    min-height: 56px;
    padding: 0 1rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 1.0625rem;
    letter-spacing: 0.04em;
  }
  input::placeholder {
    color: var(--text-dim);
  }
  form :global(.button) {
    margin-top: 0.75rem;
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
  @media (max-width: 900px) {
    .desktop-only {
      display: none;
    }
    main {
      margin-inline: 0;
      padding: 2rem 0;
    }
  }
</style>
