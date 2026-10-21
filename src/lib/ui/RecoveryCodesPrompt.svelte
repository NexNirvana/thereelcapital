<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";
  import ReauthButton from "./ReauthButton.svelte";

  // A client who closed the tab after registering the passkey has no recovery codes. Generating
  // them needs a session under 10 minutes old (POST /api/recovery-codes); the codes are shown
  // once, here, and leave the page's memory when the client confirms they saved them.
  let step = $state<"offer" | "reauth" | "codes">("offer");
  let codes = $state<string[]>([]);
  let pending = $state(false);
  let copied = $state(false);
  let failure = $state<string | null>(null);

  const isCodes = (body: unknown): body is { codes: string[] } =>
    typeof body === "object" &&
    body !== null &&
    "codes" in body &&
    Array.isArray(body.codes) &&
    body.codes.every((code) => typeof code === "string");
  const reauthRequired = (body: unknown) =>
    typeof body === "object" && body !== null && "code" in body && body.code === "REAUTH_REQUIRED";

  async function generate() {
    pending = true;
    failure = null;
    try {
      const response = await fetch("/api/recovery-codes", { method: "POST" });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isCodes(body)) {
        codes = body.codes;
        step = "codes";
      } else if (response.status === 401 && reauthRequired(body)) {
        step = "reauth";
      } else {
        failure = "No pudimos generar tus códigos. Inténtalo de nuevo.";
      }
    } catch {
      failure = "No pudimos generar tus códigos. Inténtalo de nuevo.";
    } finally {
      pending = false;
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      copied = true;
    } catch {
      copied = false;
    }
  }

  async function saved() {
    codes = [];
    await invalidateAll();
  }
</script>

<section class="prompt" aria-labelledby="recovery-prompt">
  {#if step === "codes"}
    <h2 id="recovery-prompt">Guarda tus códigos de recuperación</h2>
    <p>Se muestran una sola vez. Cada código sirve una vez si pierdes tu passkey.</p>
    <ul aria-label="Códigos de recuperación">
      {#each codes as recoveryCode (recoveryCode)}
        <li>{recoveryCode}</li>
      {/each}
    </ul>
    <div class="actions">
      <Button variant="outline" onclick={copyCodes}>Copiar códigos</Button>
      <span role="status">{copied ? "Códigos copiados." : ""}</span>
      <Button variant="primary" onclick={saved}>Ya los guardé</Button>
    </div>
  {:else}
    <h2 id="recovery-prompt">Aún no tienes códigos de recuperación</h2>
    <p>Sin ellos, perder tu passkey te deja sin acceso. Genera los tuyos ahora.</p>
    {#if step === "reauth"}
      <Notice title="Confirma tu identidad">
        Para generar los códigos, confirma con tu passkey.
      </Notice>
      <ReauthButton onconfirmed={generate} refresh={false} />
    {:else}
      <Button variant="primary" onclick={generate} disabled={pending}>
        {pending ? "Generando códigos" : "Generar códigos"}
      </Button>
    {/if}
  {/if}
  <div aria-live="assertive">
    {#if failure}<Notice title="No pudimos continuar" role="alert">{failure}</Notice>{/if}
  </div>
</section>

<style>
  .prompt {
    display: grid;
    gap: 0.75rem;
    justify-items: start;
    max-width: 40rem;
    margin-bottom: 2rem;
    padding: 1rem;
    border: 1px solid var(--rule-strong);
  }
  .prompt > * {
    margin: 0;
  }
  h2 {
    font-size: 1.125rem;
  }
  p {
    color: var(--text-muted);
  }
  ul {
    width: 100%;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--rule);
  }
  li {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--rule);
    letter-spacing: 0.04em;
    user-select: all;
  }
  .actions {
    display: grid;
    gap: 0.75rem;
  }
  [role="status"] {
    min-height: 1.5rem;
    color: var(--text-muted);
  }
</style>
