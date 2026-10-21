<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { authClient } from "#lib/auth-client.ts";
  import { recoveryErrorMessage, recoveryErrors } from "#lib/auth-messages.ts";
  import AccessShell from "#lib/ui/AccessShell.svelte";
  import Button from "#lib/ui/Button.svelte";
  import EnrollmentSteps from "#lib/ui/EnrollmentSteps.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // The server decides every step (docs/auth-and-security.md#flows); the page sends what the
  // client typed or confirmed and shows the outcome.
  // Only the first value matters: the steps drive it afterwards.
  // svelte-ignore state_referenced_locally
  let step = $state<"code" | "enroll">(data.enrolling ? "enroll" : "code");
  let code = $state("");
  let pending = $state(false);
  let failure = $state<string | null>(null);

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
      const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
      failure = recoveryErrorMessage(errorCode, error.status);
      return;
    }
    code = "";
    step = "enroll";
  }

  // The 15-minute enrollment session is gone: the only way forward is a new recovery code.
  function startOver() {
    failure = recoveryErrors.enrollmentExpired.message;
    step = "code";
  }

  async function finish() {
    await invalidateAll();
    await goto(resolve("/(app)"));
  }
</script>

<svelte:head><title>Recuperación · Reel Capital</title></svelte:head>

<AccessShell>
  {#if step === "code"}
    <h1>Recupera<br />tu acceso.</h1>
    <p class="lead">Ingresa uno de tus códigos de recuperación. Cada código se usa una sola vez.</p>
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
    <div class="failure" aria-live="assertive">
      {#if failure}<Notice title="No pudimos continuar" role="alert">{failure}</Notice>{/if}
    </div>
    <a class="back" href={resolve("/acceso")}>Volver al acceso</a>
  {:else}
    <EnrollmentSteps way="recovery" resumed={data.enrolling} onlost={startOver} onfinish={finish} />
  {/if}
</AccessShell>

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
