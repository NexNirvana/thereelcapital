<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import {
    LIVE_QUOTE_MAX_BACKOFF_MS,
    LIVE_QUOTE_MAX_POLLS,
    LIVE_QUOTE_POLL_MS,
  } from "#lib/domain/config.ts";
  import { unverifiedLine, unverifiedSince } from "#lib/ui/connection-alert.ts";
  import LiveQuoteNote from "#lib/ui/LiveQuoteNote.svelte";
  import OptionChainPanel from "#lib/ui/OptionChainPanel.svelte";
  import type { ChainView } from "#lib/ui/chain-view.ts";
  import { entryFromMessage, readLiveEntry, type LiveEntry } from "#lib/ui/live-entry.ts";
  import { startLiveFeed } from "#lib/ui/live-feed.ts";
  import { contractLabel } from "#lib/ui/option-chain.ts";
  import { formatPrice, formatQuantity, formatSize, limitsLine } from "#lib/ui/new-entry.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  // The shell's connection: while it is down the counts are the last ones the engine saw.
  const unverified = $derived(unverifiedSince(data.connection));

  // What the form shows right now. Editing the symbol or the account makes the preview on screen
  // belong to something the client no longer asks for, so it is dropped until they ask again.
  let typedSymbol = $derived(data.symbol);
  let chosenAccount = $derived(data.accountId ?? "");
  const stale = $derived(
    typedSymbol.trim().toUpperCase() !== data.symbol || chosenAccount !== (data.accountId ?? ""),
  );

  // The price keeps updating while the screen is open (D46). It is display only: the send asks the
  // engine again, and the browser never sends a price or a quantity.
  let live = $state<LiveEntry | null>(null);
  const quoteHref = $derived(
    data.accountId === null || data.symbol === ""
      ? null
      : `${resolve("/(app)/operar/cotizacion")}?${new URLSearchParams({
          tipo: data.tipo,
          cuenta: data.accountId,
          simbolo: data.symbol,
        })}`,
  );
  // A new page load (another symbol, account or search) starts from what the server just read.
  $effect.pre(() => {
    void data;
    live = null;
  });
  $effect(() => {
    const href = quoteHref;
    if (href === null) return;
    // The socket pushes every tick (D47); the poll of D46 runs only while it is not delivering.
    return startLiveFeed({
      watch: {
        type: "watch",
        entry: {
          accountId: data.accountId ?? "",
          symbol: data.symbol,
          assetType: data.tipo === "opciones" ? "option" : "equity",
        },
      },
      onMessage: (message) => {
        live = entryFromMessage(message, live) ?? live;
      },
      poll: {
        intervalMs: LIVE_QUOTE_POLL_MS,
        maxPolls: LIVE_QUOTE_MAX_POLLS,
        maxBackoffMs: LIVE_QUOTE_MAX_BACKOFF_MS,
        run: async (signal) => {
          const answer = await readLiveEntry(href, fetch, signal);
          // An answer for an entry that is no longer on screen is dropped.
          if (answer !== null && !signal.aborted) live = answer;
          return answer !== null;
        },
      },
    });
  });
  // The engine found the quantity had changed since the client saw it: nothing was sent, and the
  // quantity it returned replaces the one on screen until the live feed updates it. It comes from
  // the action's own answer, so it also shows without JavaScript.
  const changed = $derived(form !== null && "reconfirm" in form ? form.reconfirm : undefined);
  const preview = $derived(
    stale
      ? null
      : live === null
        ? (changed ?? data.preview)
        : live.status === "ready"
          ? live.preview
          : null,
  );
  const blocked = $derived(
    stale ? null : live === null ? data.blocked : live.status === "blocked" ? live.message : null,
  );
  const quotedAt = $derived(live?.status === "ready" ? live.receivedAt : data.quotedAt);

  const tabs = $derived([
    { id: "acciones", label: "Acciones", href: `${resolve("/(app)/operar")}?tipo=acciones` },
    { id: "opciones", label: "Opciones", href: `${resolve("/(app)/operar")}?tipo=opciones` },
  ]);
  const contract = $derived(data.contract);
  // Before any underlying is typed there is no chain, only the empty field.
  const emptyChain: ChainView = {
    underlying: "",
    expiration: "",
    expirationText: "",
    nowMs: 0,
    choice: null,
    notice: null,
    expirations: null,
    chain: null,
    problem: null,
  };

  // The summary on screen is the confirmation: «Enviar orden» posts the entry as shown. The form
  // carries only the entry, this page's intent id and the quantity on screen, which the engine
  // compares with its own and never uses (CLAUDE.md, never-break rule 3).
  const intentId = $derived(stale ? null : (data.preview?.intentId ?? null));
  const canSend = $derived(preview !== null && intentId !== null && data.accountId !== null);
  // The page opened without a price (market closed, a pending symbol) and one arrived through the
  // live feed: reload once for the intent id the send needs.
  let reloadedFor = "";
  $effect(() => {
    const entry = `${data.tipo}|${data.accountId}|${data.symbol}`;
    if (stale || preview === null || data.preview !== null || reloadedFor === entry) return;
    reloadedFor = entry;
    void invalidateAll();
  });

  // The quantity the engine returned when it found the price had moved: shown in place of the one
  // the client saw, and sent once more only when they press «Enviar con N».
  let sending = $state(false);
  const failure = $derived(form !== null && "message" in form ? form.message : null);
  const reason = $derived(
    sending
      ? "Enviando la orden…"
      : (blocked ??
          (preview === null
            ? data.tipo === "acciones"
              ? "Escribe un símbolo y consulta para ver tu orden."
              : "Elige un contrato para ver tu orden."
            : intentId === null
              ? "Preparando la orden…"
              : null)),
  );
  const sendLabel = $derived(
    sending
      ? "Enviando…"
      : changed !== undefined && preview
        ? `Enviar con ${formatQuantity(preview.qty, preview.assetType)}`
        : "Enviar orden",
  );
  const sendAction = $derived(
    `?${new URLSearchParams({ tipo: data.tipo, cuenta: data.accountId ?? "", simbolo: data.symbol })}&/enviar`,
  );
</script>

<svelte:head><title>Nueva entrada · Reel Capital</title></svelte:head>

<div class="page">
  <header class="head">
    <p class="crumb">Operar / Nueva entrada</p>
    <h1>Nueva entrada</h1>
    <p class="lead">Selecciona el instrumento y revisa tu orden.</p>
  </header>

  {#if data.limits}
    <p class="limits">
      {limitsLine(data.limits)}{#if unverified !== undefined}
        <span class="unverified"> · {unverifiedLine(unverified)}</span>{/if}
    </p>
  {/if}

  <section class="form" aria-label="Instrumento">
    <nav class="tabs" aria-label="Tipo de instrumento">
      {#each tabs as tab (tab.id)}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built with resolve() above -->
        <a href={tab.href} aria-current={data.tipo === tab.id ? "page" : undefined}>{tab.label}</a>
      {/each}
    </nav>

    {#if data.tipo === "acciones"}
      <form method="GET" action={resolve("/(app)/operar")}>
        <input type="hidden" name="tipo" value={data.tipo} />
        {#if data.accounts.length > 1}
          <label class="field">
            <span>Cuenta</span>
            <select name="cuenta" bind:value={chosenAccount}>
              {#each data.accounts as account (account)}
                <option value={account}>{account}</option>
              {/each}
            </select>
          </label>
        {:else if data.accountId}
          <input type="hidden" name="cuenta" value={data.accountId} />
        {/if}
        <label class="field">
          <span>Símbolo</span>
          <input
            class="field-input"
            name="simbolo"
            bind:value={typedSymbol}
            maxlength="32"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            placeholder="SPY"
          />
        </label>
        <div class="actions"><Button type="submit" variant="outline">Consultar</Button></div>
      </form>
    {:else}
      <OptionChainPanel
        view={data.chainView ?? emptyChain}
        accountId={data.accountId}
        accounts={data.accounts}
        initialStrike={data.strike}
        initialCount={data.strikeCount}
        chosenSymbol={data.symbol}
      />
      {#if contract}
        <div class="field chosen">
          <span>Contrato elegido</span>
          <p class="selector">
            <span class="underlying">{contract.underlying}</span>
            <span class="divider" aria-hidden="true"></span>
            <span class="contract">{contractLabel(contract)}</span>
          </p>
          <p class="symbol-line">Símbolo del contrato: <strong>{contract.symbol}</strong></p>
        </div>
      {/if}
    {/if}

    <dl>
      <DefinitionRow
        label="SIZE por entrada"
        value={preview ? formatSize(preview.sizeMicros) : "—"}
      />
      <DefinitionRow
        label="Ask de referencia"
        value={preview ? formatPrice(preview.askMicros) : "—"}
      />
      <DefinitionRow
        label="Cantidad estimada"
        value={preview ? formatQuantity(preview.qty, preview.assetType) : "—"}
      />
      <DefinitionRow label="Tipo de orden" value="Market" />
    </dl>
    <p class="caption">La cantidad se calcula automáticamente.</p>
    {#if preview && quotedAt}<LiveQuoteNote receivedAt={quotedAt} />{/if}
  </section>

  <section class="summary" id="resumen" aria-label="Resumen">
    <p class="label">Resumen</p>
    {#if contract}
      <p class="instrument">{contract.underlying}</p>
      <p class="contract-name">{contractLabel(contract)}</p>
    {:else}
      <p class="instrument">{preview ? preview.symbol : "—"}</p>
    {/if}
    <dl>
      {#if contract}
        <DefinitionRow label="Subyacente" value={contract.underlying} />
        <DefinitionRow label="Contrato" value={contract.symbol} />
      {/if}
      {#if data.accountId}
        <DefinitionRow label="Cuenta" value={`TradeStation · ${data.accountId}`} />
      {/if}
      <DefinitionRow label="Modo" value="SIM · sin dinero real" />
      <DefinitionRow label="Acción" value="Comprar para abrir" />
      <DefinitionRow
        label="Cantidad"
        value={preview ? formatQuantity(preview.qty, preview.assetType) : "—"}
      />
      <DefinitionRow
        label="Stop loss inicial"
        value={data.stopPct === null ? "—" : `${data.stopPct}%`}
      />
    </dl>
    <p class="note">Orden de mercado en simulación.</p>

    {#if changed !== undefined && preview}
      <Notice title="La cantidad cambió" role="alert">
        El precio o tu SIZE cambiaron. Antes eran {formatQuantity(
          changed.previousQty,
          preview.assetType,
        )} y ahora son {formatQuantity(preview.qty, preview.assetType)}.
      </Notice>
    {/if}
    {#if failure}
      <Notice title="No se envió la orden" role="alert">{failure}</Notice>
    {/if}

    <form
      class="review"
      method="POST"
      action={sendAction}
      use:enhance={({ cancel }) => {
        // A second click before the first answer must not become a second request.
        if (sending) {
          cancel();
          return;
        }
        sending = true;
        return async ({ result, update }) => {
          // A new quantity is not a navigation: keep the page as it is and let `form` show it.
          await update({ reset: false, invalidateAll: false });
          // A refused send (a limit, the engine) reads the page again, so the reason and the
          // disabled button come from the server instead of the preview that was just refused.
          if (result.type === "failure") await invalidateAll();
          sending = false;
        };
      }}
    >
      {#if canSend && preview}
        <input type="hidden" name="tipo" value={data.tipo} />
        <input type="hidden" name="cuenta" value={data.accountId} />
        <input type="hidden" name="simbolo" value={data.symbol} />
        <input type="hidden" name="intentId" value={intentId} />
        <input type="hidden" name="cantidad" value={preview.qty} />
      {/if}
      <Button
        type="submit"
        variant="primary"
        disabled={!canSend || sending}
        aria-describedby="review-reason"
      >
        {sendLabel}
      </Button>
      <p id="review-reason" class="reason" aria-live="polite">{reason}</p>
    </form>
  </section>

  <p class="mode">SIM · Simulación, sin dinero real</p>
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: 55fr 40fr;
    grid-template-areas:
      "head limits"
      "form summary"
      "mode mode";
    column-gap: 5%;
    row-gap: 2.5rem;
    max-width: 1000px;
  }
  .head {
    grid-area: head;
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
  .unverified {
    color: var(--text-muted);
  }
  .limits {
    grid-area: limits;
    align-self: end;
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .form {
    grid-area: form;
    min-width: 0;
  }
  .summary {
    grid-area: summary;
    min-width: 0;
    padding-left: 5%;
    border-left: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
  }
  .mode {
    grid-area: mode;
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
  }

  .tabs {
    display: flex;
    gap: 2rem;
    margin-bottom: 1.5rem;
  }
  .tabs a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    text-decoration: none;
  }
  .tabs a[aria-current="page"] {
    border-bottom-color: var(--text);
    color: var(--text);
    font-weight: 500;
  }

  .field {
    display: block;
    margin-bottom: 1rem;
  }
  .field > span {
    display: block;
    margin-bottom: 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .selector,
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: 64px;
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  .selector {
    font-size: 28px;
    font-weight: 600;
  }
  select {
    min-height: var(--target);
  }
  .selector {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .divider {
    align-self: stretch;
    border-left: 1px solid var(--rule-strong);
  }
  .contract {
    font-size: 20px;
    font-weight: 500;
  }
  .symbol-line {
    margin: 0.5rem 0 1rem;
    color: var(--text-dim);
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .symbol-line strong {
    color: var(--text);
    font-weight: 500;
  }
  .contract-name {
    margin: -1rem 0 1.5rem;
    color: var(--text-muted);
    font-size: 18px;
  }
  .chosen {
    margin-top: 1.5rem;
  }
  .actions {
    margin-bottom: 1rem;
  }
  .actions :global(.button) {
    min-width: 11rem;
  }
  dl {
    margin: 1.5rem 0 0;
    border-top: 1px solid var(--rule);
  }
  .caption,
  .note {
    margin: 1rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .label {
    margin: 0 0 1rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .instrument {
    margin: 0 0 1.5rem;
    font-size: 32px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .summary dl {
    margin-top: 0;
  }
  .review {
    margin-top: auto;
    padding-top: 2.5rem;
  }
  .reason {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  @media (max-width: 900px) {
    .page {
      grid-template-columns: 1fr;
      grid-template-areas: "head" "form" "summary" "limits" "mode";
      row-gap: 2rem;
    }
    .limits {
      align-self: start;
    }
    .summary {
      padding-left: 0;
      border-left: 0;
    }
  }
</style>
