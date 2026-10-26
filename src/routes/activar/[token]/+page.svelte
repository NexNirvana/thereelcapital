<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { authClient } from "#lib/auth-client.ts";
  import { activationErrorMessage, activationErrors } from "#lib/auth-messages.ts";
  import AccessShell from "#lib/ui/AccessShell.svelte";
  import Button from "#lib/ui/Button.svelte";
  import EnrollmentSteps from "#lib/ui/EnrollmentSteps.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // The server decides every step (docs/auth-and-security.md#flows): it validates the token, spends
  // the link with the passkey and issues the codes. The page only sends them and shows the outcome.
  // Only the first value matters: the steps drive it afterwards.
  // svelte-ignore state_referenced_locally
  let step = $state<"start" | "enroll">(data.enrolling ? "enroll" : "start");
  let pending = $state(false);
  let failure = $state<string | null>(null);

  async function open() {
    pending = true;
    failure = null;
    const { error } = await authClient.$fetch("/activation/redeem", {
      method: "POST",
      body: { token: page.params.token },
    });
    pending = false;
    if (error) {
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
      failure = activationErrorMessage(code, error.status);
      return;
    }
    step = "enroll";
  }

  // The 15-minute enrollment session is gone; the same link opens a new one while it still works.
  function startOver(message?: string) {
    failure = message ?? activationErrors.enrollmentLost.message;
    step = "start";
  }

  // A full document load: this page's `no-referrer` policy would otherwise follow a client-side
  // navigation, and the browser then sends `Origin: null` on /conexion's POSTs (rejected as cross-site).
  function finish() {
    location.assign(resolve("/(app)/conexion"));
  }
</script>

<svelte:head><title>Activación · Reel Capital</title></svelte:head>

<AccessShell>
  {#if step === "start"}
    <h1>Activa<br />tu acceso.</h1>
    <p class="lead">
      Este enlace es personal y de un solo uso. Crearás una passkey con huella, rostro o PIN y
      guardarás tus códigos de recuperación.
    </p>
    <Button variant="primary" onclick={open} disabled={pending}>
      {pending ? "Verificando" : "Comenzar"}
    </Button>
    <div class="failure" aria-live="assertive">
      {#if failure}<Notice title="No pudimos continuar" role="alert">{failure}</Notice>{/if}
    </div>
    <a class="back" href={resolve("/acceso")} data-sveltekit-reload>Ya tengo passkey</a>
  {:else}
    <EnrollmentSteps
      way="activation"
      resumed={data.enrolling}
      onlost={startOver}
      onfinish={finish}
    />
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
