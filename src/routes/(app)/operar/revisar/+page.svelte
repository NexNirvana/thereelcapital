<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import { formatPrice, formatQuantity, formatSize } from "#lib/ui/new-entry.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  // The quantity the engine returned when it found the price had moved. Shown in place of the one
  // the review opened with, and sent back as the quantity the client has now seen.
  const reconfirm = $derived(form !== null && "reconfirm" in form ? form.reconfirm : null);
  const shown = $derived(reconfirm ?? data.preview);
  const failure = $derived(form !== null && "message" in form ? form.message : null);

  // The action's response renders this page again, so the URL keeps the entry being reviewed.
  const sendAction = $derived(
    `?${new URLSearchParams({ tipo: data.tipo, cuenta: data.accountId, simbolo: data.symbol })}&/enviar`,
  );

  let sending = $state(false);
  const isOption = $derived(data.tipo === "opciones");
</script>

<svelte:head><title>Revisar orden · Reel Capital</title></svelte:head>

<div class="page">
  <header>
    <p class="crumb">Operar / Revisar orden</p>
    <h1>Revisar orden</h1>
    <p class="lead">Confirma los detalles antes de enviar.</p>
  </header>

  {#if shown === null}
    <Notice title="No podemos preparar esta orden" role="alert">{data.blocked}</Notice>
    <p><Button variant="link" href={resolve("/(app)/operar")}>Volver a Nueva entrada</Button></p>
  {:else}
    {#if reconfirm}
      <Notice title="La cantidad cambió" role="alert">
        El precio o tu SIZE cambiaron mientras revisabas. Antes eran {formatQuantity(
          reconfirm.previousQty,
          reconfirm.assetType,
        )} y ahora son {formatQuantity(reconfirm.qty, reconfirm.assetType)}. Confirma la nueva
        cantidad para enviar.
      </Notice>
    {/if}
    {#if failure}
      <Notice title="No se envió la orden" role="alert">{failure}</Notice>
    {/if}

    <section aria-label="Orden">
      <dl>
        <DefinitionRow label="Cuenta" value={`TradeStation · ${data.accountId}`} />
        <DefinitionRow label="Modo" value="SIM · sin dinero real" />
        {#if isOption}
          <DefinitionRow label="Subyacente" value={data.underlying} />
          <DefinitionRow label="Contrato" value={data.symbol} />
        {:else}
          <DefinitionRow label="Instrumento" value={data.symbol} />
        {/if}
        <DefinitionRow label="Acción" value="Comprar para abrir" />
        <DefinitionRow label="SIZE por entrada" value={formatSize(shown.sizeMicros)} />
        <DefinitionRow label="Ask de referencia" value={formatPrice(shown.askMicros)} />
        <DefinitionRow label="Cantidad" value={formatQuantity(shown.qty, shown.assetType)} />
        <DefinitionRow label="Tipo de orden" value="Market" />
      </dl>
      <p class="note">
        Orden de mercado: se ejecuta al precio disponible, que puede diferir del ask de referencia.
      </p>
    </section>

    <form
      method="POST"
      action={sendAction}
      use:enhance={({ cancel }) => {
        // A second click before the first answer must not become a second request.
        if (sending) {
          cancel();
          return;
        }
        sending = true;
        return async ({ update }) => {
          await update();
          sending = false;
        };
      }}
    >
      <input type="hidden" name="tipo" value={data.tipo} />
      <input type="hidden" name="cuenta" value={data.accountId} />
      <input type="hidden" name="simbolo" value={data.symbol} />
      <input type="hidden" name="intentId" value={data.preview?.intentId ?? ""} />
      <input type="hidden" name="cantidad" value={shown.qty} />
      <Button type="submit" variant="primary" disabled={sending}>
        {sending ? "Enviando…" : reconfirm ? "Confirmar y enviar" : "Enviar orden"}
      </Button>
    </form>
    <p><Button variant="link" href={resolve("/(app)/operar")}>Volver a Nueva entrada</Button></p>
  {/if}

  <p class="mode">SIM · Simulación, sin dinero real</p>
</div>

<style>
  .page {
    display: grid;
    gap: 1.5rem;
    max-width: 560px;
  }
  .crumb {
    margin: 0 0 1rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  h1 {
    margin: 0;
    font-size: clamp(32px, 4vw, 42px);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: -0.02em;
  }
  .lead {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }
  dl {
    margin: 0;
    border-top: 1px solid var(--rule);
  }
  .note,
  .mode {
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  p {
    margin: 0;
  }
</style>
