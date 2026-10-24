<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { signInWithPasskey, warmPasskeyClient } from "#lib/passkey-sign-in.ts";
  import Badge from "#lib/ui/Badge.svelte";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import { indicatorFor } from "#lib/ui/connection-indicator.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const connected = $derived(data.connection?.status === "CONNECTED" && !form?.disconnected);
  // The failure of the last attempt: from this page's own action or from the OAuth callback.
  const problem = $derived(form && "message" in form ? form.message : data.error);
  const needsLogin = $derived(form !== null && "code" in form && form.code === "REAUTH_REQUIRED");
  const indicator = $derived(
    data.connection?.status === "CONNECTED" ? indicatorFor(data.connection.health) : null,
  );
  // Paste mode (D35): after the key is saved, TradeStation opens in a new tab and the client pastes back.
  const authorizeUrl = $derived(
    form !== null && "authorizeUrl" in form && typeof form.authorizeUrl === "string"
      ? form.authorizeUrl
      : null,
  );
  const awaitingPaste = $derived(
    authorizeUrl !== null ||
      (form !== null && "awaitingPaste" in form && form.awaitingPaste === true),
  );
  let reconnect = $state(false);
  let confirming = $state(false);
  let confirmFailure = $state<string | null>(null);

  // The passkey button only appears after a REAUTH_REQUIRED answer; warm the client as it does.
  $effect(() => {
    if (needsLogin) warmPasskeyClient();
  });

  // A session older than 10 minutes cannot save credentials: a passkey sign-in opens a fresh one.
  async function confirmIdentity() {
    confirming = true;
    confirmFailure = null;
    confirmFailure = await signInWithPasskey();
    confirming = false;
    if (confirmFailure) return;
    await goto(resolve("/(app)/conexion"), { invalidateAll: true });
  }
</script>

<svelte:head><title>Conexión · Reel Capital</title></svelte:head>

<h1>Conexión</h1>
<p class="lead">Tu propia API key de TradeStation. Solo operas en tus cuentas.</p>

<div class="messages" aria-live="polite">
  {#if problem}
    <Notice title="No pudimos conectar" role="alert">
      {problem}
    </Notice>
  {/if}
  {#if needsLogin}
    <Button variant="outline" type="button" onclick={confirmIdentity} disabled={confirming}>
      {confirming ? "Esperando tu passkey" : "Confirmar con passkey"}
    </Button>
    {#if confirmFailure}<Notice title="No pudimos confirmar" role="alert">{confirmFailure}</Notice
      >{/if}
  {/if}
  {#if form?.disconnected}
    <Notice title="Desconectado">
      {#if form.revoked}
        Revocamos el acceso en TradeStation y borramos tus credenciales.
      {:else}
        Borramos tus credenciales, pero no pudimos revocar el acceso en TradeStation. Revócalo desde
        tu cuenta de TradeStation.
      {/if}
    </Notice>
  {/if}
</div>

{#if connected && data.connection?.status === "CONNECTED"}
  <section aria-labelledby="estado">
    <h2 id="estado">Estado</h2>
    <dl>
      <DefinitionRow label="TradeStation" value={indicator?.state ?? "Conectado"} />
      <DefinitionRow label="Vencimiento" value={data.connection.expiresAt ?? "desconocido"} />
    </dl>
    {#if data.connection.health.status !== "ok"}
      <Notice
        title={data.connection.health.status === "expiring"
          ? "Tu conexión vence pronto"
          : "Tu conexión con TradeStation no está disponible"}
        role={data.connection.health.status === "expiring" ? "status" : "alert"}
      >
        {#if data.connection.health.status === "expiring"}
          Reconecta antes del vencimiento para no interrumpir tus operaciones.
        {:else}
          No se pueden abrir entradas y la protección de tus posiciones no está verificada.
          Reconecta con TradeStation para continuar.
        {/if}
      </Notice>
    {/if}
    {#if data.connection.entriesBlocked && ["ok", "expiring"].includes(data.connection.health.status)}
      <Notice title="Verificando tus posiciones">
        La conexión se restableció. Revisamos tus órdenes y posiciones antes de abrir nuevas
        entradas.
      </Notice>
    {/if}
    <p class="mode">
      <span>Modo</span>
      <Badge label="SIM" />
      <span class="dim">REAL no está disponible.</span>
    </p>
  </section>

  <section aria-labelledby="cuentas">
    <h2 id="cuentas">Cuentas SIM</h2>
    {#if data.connection.accounts.length === 0}
      <Notice title="Sin cuentas">
        No encontramos cuentas SIM activas (Cash o Margin) en tu API key.
      </Notice>
    {:else}
      <dl>
        {#each data.connection.accounts as account (account.accountId)}
          <DefinitionRow label={account.accountId} value={account.accountType} />
        {/each}
      </dl>
    {/if}
  </section>

  <div class="actions">
    <Button variant="outline" type="button" onclick={() => (reconnect = !reconnect)}>
      Reconectar con TradeStation
    </Button>
    <form method="POST" action="?/disconnect">
      <Button variant="link" type="submit">Desconectar</Button>
    </form>
  </div>
{/if}

{#if !connected || reconnect}
  <section aria-labelledby="registro">
    <h2 id="registro">Conecta tu API key</h2>
    {#if data.callbackUrl}
      <ol>
        <li>
          Registra esta URL de callback en tu API key de TradeStation:
          <code class="callback"
            >{#each data.callbackUrl.split("/") as part, index (index)}{#if index > 0}/<wbr
                />{/if}{part}{/each}</code
          >
        </li>
        <li>Escribe tu API key y tu secreto. Se guardan cifrados y no vuelven a mostrarse.</li>
        <li>Autoriza el acceso en TradeStation. Volverás aquí con tus cuentas SIM.</li>
      </ol>
    {:else}
      <p class="steps">
        Escribe tu API key y tu secreto. Se guardan cifrados y no vuelven a mostrarse.
      </p>
    {/if}

    <form
      method="POST"
      action="?/connect"
      autocomplete="off"
      use:enhance={() =>
        async ({ formElement, result, update }) => {
          // Runs after the response, outside the click's task, so Safari may block the tab; the link below is the reliable path.
          if (
            result.type === "success" &&
            typeof result.data?.authorizeUrl === "string" &&
            result.data.authorizeUrl.startsWith("https://signin.tradestation.com/")
          ) {
            window.open(result.data.authorizeUrl, "_blank", "noopener,noreferrer");
          }
          // The secret never stays in the field, whether the save worked or not.
          formElement.reset();
          await update();
        }}
    >
      <label>
        API key (client ID)
        <input name="clientId" required spellcheck="false" autocapitalize="none" />
      </label>
      <label>
        Secreto
        <input name="clientSecret" type="password" required autocomplete="off" />
      </label>
      <Button variant={awaitingPaste ? "outline" : "primary"} type="submit"
        >Conectar con TradeStation</Button
      >
    </form>

    {#if !data.callbackUrl && awaitingPaste}
      <h2>Completa la conexión</h2>
      <ol>
        {#if authorizeUrl?.startsWith("https://signin.tradestation.com/")}
          <li>
            Inicia sesión en la pestaña de TradeStation y autoriza el acceso.
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external TradeStation URL built by the engine, checked above -->
            <a href={authorizeUrl} target="_blank" rel="noopener noreferrer"
              >Abrir TradeStation de nuevo</a
            >
          </li>
        {:else}
          <li>Inicia sesión en la pestaña de TradeStation y autoriza el acceso.</li>
        {/if}
        <li>
          La página siguiente no va a cargar. Es lo esperado: copia la dirección completa de la
          barra del navegador.
        </li>
        <li>Pégala aquí y completa la conexión.</li>
      </ol>
      <form method="POST" action="?/paste" autocomplete="off">
        <label>
          Dirección copiada
          <textarea
            name="redirect"
            rows="3"
            required
            spellcheck="false"
            autocapitalize="none"
            autocomplete="off"
            placeholder="http://localhost:3000/?code=…&state=…"></textarea>
        </label>
        <Button variant="primary" type="submit">Completar conexión</Button>
      </form>
    {/if}
  </section>
{/if}

<style>
  h1 {
    font-size: clamp(28px, 4vw, 40px);
  }
  h2 {
    margin: 2.5rem 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .lead,
  .dim {
    color: var(--text-muted);
  }
  section,
  .messages {
    max-width: 40rem;
  }
  .messages {
    margin-top: 1.5rem;
    display: grid;
    gap: 1rem;
  }
  .messages:empty {
    margin: 0;
  }
  dl {
    margin: 0;
    border-top: 1px solid var(--rule);
  }
  .mode {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1.5rem;
    margin-top: 2.5rem;
  }
  ol {
    padding-left: 1.5rem;
    color: var(--text-muted);
  }
  li {
    margin-bottom: 0.75rem;
  }
  .callback {
    display: block;
    margin-top: 0.5rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--rule-strong);
    color: var(--text);
    overflow-wrap: anywhere;
    user-select: all;
  }
  form {
    display: grid;
    gap: 1.25rem;
    margin-top: 1.5rem;
  }
  .actions form {
    margin: 0;
  }
  label {
    display: grid;
    gap: 0.5rem;
  }
  .steps {
    color: var(--text-muted);
  }
  textarea,
  input {
    min-height: var(--target);
    padding: 0 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  textarea {
    padding: 0.75rem;
    overflow-wrap: anywhere;
    resize: vertical;
  }
  textarea:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
