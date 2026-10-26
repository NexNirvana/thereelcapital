<script module lang="ts">
  export interface ComboOption<K> {
    readonly key: K;
    readonly label: string;
    readonly aside?: string;
  }
</script>

<script lang="ts" generics="Key extends string | number | null">
  // A labelled combobox: a text field with a list of options below it (↑↓ move, Enter picks, Escape
  // closes, click picks). The screen decides what the options are and what picking one means; this
  // only draws them and wires the keyboard, with `aria-activedescendant` so focus stays in the input.
  let {
    id,
    label,
    text = $bindable(),
    options,
    readonly = false,
    disabled = false,
    placeholder,
    inputmode,
    onedit,
    onpick,
    oncommit,
    oncancel,
  }: {
    id: string;
    label: string;
    text: string;
    options: ReadonlyArray<ComboOption<Key>>;
    /** A choice from a fixed list: the list opens on click or ↓ instead of while typing. */
    readonly?: boolean;
    disabled?: boolean;
    placeholder?: string;
    inputmode?: "decimal";
    /** The user typed into the field. */
    onedit?: (typed: string) => void;
    onpick: (key: Key) => void;
    /** The field lost focus or Enter was pressed with no option highlighted. */
    oncommit?: () => void;
    /** Escape was pressed. */
    oncancel?: () => void;
  } = $props();

  const listId = $derived(`${id}-lista`);
  let open = $state(false);
  let active = $state(0);
  const listed = $derived(open && options.length > 0);

  function pick(option: ComboOption<Key>) {
    open = false;
    onpick(option.key);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      open = false;
      oncancel?.();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      if (!open) {
        open = true;
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + options.length) % options.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = listed ? options[active] : undefined;
      if (chosen !== undefined) pick(chosen);
      else if (readonly) open = !open;
      else oncommit?.();
    }
  }

  $effect(() => {
    if (listed)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="field">
  <label for={id}>{label}</label>
  <div class="combo">
    <input
      {id}
      class="field-input"
      class:chevron={readonly}
      role="combobox"
      aria-expanded={listed}
      aria-controls={listId}
      aria-autocomplete={readonly ? "none" : "list"}
      aria-activedescendant={listed ? `${listId}-${active}` : undefined}
      autocomplete="off"
      spellcheck="false"
      {placeholder}
      {inputmode}
      {readonly}
      {disabled}
      value={text}
      oninput={(event) => {
        text = event.currentTarget.value;
        active = 0;
        open = true;
        onedit?.(text);
      }}
      onfocus={(event) => {
        if (readonly) return;
        event.currentTarget.select();
        active = 0;
        open = true;
      }}
      onclick={() => {
        if (!readonly) return;
        active = Math.max(
          0,
          options.findIndex((option) => option.label === text),
        );
        open = !open;
      }}
      onblur={() => {
        open = false;
        oncommit?.();
      }}
      {onkeydown}
    />
    {#if readonly}<span class="chev" aria-hidden="true">▾</span>{/if}
    <ul id={listId} class="list" role="listbox" aria-label={label} hidden={!listed}>
      {#each options as option, index (option.key)}
        <!-- Keyboard use goes through the input (aria-activedescendant); the mouse picks here. -->
        <li
          id="{listId}-{index}"
          role="option"
          aria-selected={index === active}
          onmousedown={(event) => {
            event.preventDefault();
            pick(option);
          }}
        >
          <span>{option.label}</span>
          {#if option.aside}<span class="aside">{option.aside}</span>{/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .field {
    min-width: 0;
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
  .chevron {
    padding-right: 2.5rem;
    cursor: pointer;
  }
  .chev {
    position: absolute;
    top: 50%;
    right: 1rem;
    transform: translateY(-50%);
    color: var(--text-dim);
    font-size: 14px;
    pointer-events: none;
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
    justify-content: space-between;
    gap: 0.75rem;
    min-height: var(--target);
    padding: 0 1rem;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }
  li[aria-selected="true"],
  li:hover {
    background: var(--done);
    color: var(--text);
  }
  .aside {
    min-width: 0;
    overflow: hidden;
    color: var(--text-dim);
    text-overflow: ellipsis;
  }
</style>
