<script lang="ts">
  import { goto } from "$app/navigation";
  import Button from "./Button.svelte";
  import {
    choiceFor,
    resolveExpiration,
    shortDate,
    suggest,
    suggestionLabel,
    type Choice,
  } from "./expiration-field.ts";

  // The «Vencimiento» combobox. Without JavaScript it is a text field in a GET form whose answer the
  // server resolves with the same functions; with it, the listed expirations are suggested as you
  // type. The server still checks whatever arrives (docs/screens-and-flows.md, /operar/cadena).
  let {
    action,
    fields,
    expirations,
    text,
    nowMs,
    choice,
    hrefFor,
  }: {
    action: string;
    /** Hidden inputs the form carries (the underlying and the account). */
    fields: Record<string, string>;
    expirations: ReadonlyArray<string>;
    /** What the field shows when nothing was typed: the chosen expiration, or the rejected text. */
    text: string;
    nowMs: number;
    /** The server's answer to text that named no single listed date. */
    choice: Choice | null;
    hrefFor: (isoDate: string) => string;
  } = $props();

  const listId = "vencimiento-lista";
  const now = $derived(new Date(nowMs));
  let typed = $state<string | null>(null);
  let open = $state(false);
  let active = $state(0);

  const value = $derived(typed ?? text);
  const options = $derived(suggest(expirations, typed ?? "", now));
  const shownChoice = $derived(
    typed === null ? choice : choiceFor(resolveExpiration(expirations, typed, now), typed),
  );
  const listed = $derived(open && options.length > 0);

  // A new answer from the server (another expiration, another symbol) replaces what was typed.
  $effect(() => {
    void text;
    typed = null;
  });

  function pick(isoDate: string) {
    open = false;
    typed = null;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor is built with resolve()
    void goto(hrefFor(isoDate));
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      open = false;
      typed = null;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      open = true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + options.length) % options.length;
    } else if (event.key === "Enter" && listed) {
      const chosen = options[active];
      if (chosen !== undefined) {
        event.preventDefault();
        pick(chosen);
      }
    }
  }

  $effect(() => {
    if (listed)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  });
</script>

<form method="GET" {action}>
  {#each Object.entries(fields) as [name, fieldValue] (name)}
    <input type="hidden" {name} value={fieldValue} />
  {/each}
  <div class="field">
    <label for="vencimiento">Vencimiento</label>
    <div class="combo">
      <input
        id="vencimiento"
        class="symbol"
        name="vencimiento"
        role="combobox"
        aria-expanded={listed}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listed ? `${listId}-${active}` : undefined}
        autocomplete="off"
        spellcheck="false"
        placeholder="30 oct"
        {value}
        oninput={(event) => {
          typed = event.currentTarget.value;
          active = 0;
          open = true;
        }}
        onfocus={(event) => {
          event.currentTarget.select();
          active = 0;
          open = true;
        }}
        onblur={() => (open = false)}
        {onkeydown}
      />
      <ul id={listId} class="list" role="listbox" aria-label="Vencimientos" hidden={!listed}>
        {#each options as isoDate, index (isoDate)}
          <!-- Keyboard use goes through the input (aria-activedescendant); the mouse picks here. -->
          <li
            id="{listId}-{index}"
            role="option"
            aria-selected={index === active}
            onmousedown={(event) => {
              event.preventDefault();
              pick(isoDate);
            }}
          >
            {suggestionLabel(isoDate, now)}
          </li>
        {/each}
      </ul>
    </div>
    <p class="hint">Escribe «30 oct», «nov», «2027» o «2026-10-30».</p>
  </div>
  <Button type="submit" variant="outline">Ver vencimiento</Button>
</form>

{#if shownChoice}
  <p class="choice" aria-live="polite">
    {shownChoice.lead}
    {#each shownChoice.dates as isoDate, index (isoDate)}
      {#if index > 0}
        ·
      {/if}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor is built with resolve() -->
      <a href={hrefFor(isoDate)}>{shortDate(isoDate, now)}</a>
    {/each}
  </p>
{/if}

<style>
  .field {
    margin-bottom: 1rem;
  }
  label {
    display: block;
    margin: 0 0 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .combo {
    position: relative;
  }
  .symbol {
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
    font-size: 28px;
    font-weight: 600;
  }
  .list {
    position: absolute;
    z-index: 5;
    inset: 100% 0 auto;
    max-height: 280px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border: 1px solid var(--text);
    border-top: 0;
    background: var(--surface);
    list-style: none;
  }
  .list[hidden] {
    display: none;
  }
  li {
    display: flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 1rem;
    color: var(--text-muted);
    cursor: pointer;
  }
  li[aria-selected="true"],
  li:hover {
    background: var(--done);
    color: var(--text);
  }
  .hint {
    margin: 0.375rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .choice {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }
  .choice a {
    color: var(--text);
    text-underline-offset: 4px;
  }
  form :global(.button) {
    min-width: 11rem;
  }

  @media (max-width: 480px) {
    .symbol {
      font-size: 18px;
    }
  }
</style>
