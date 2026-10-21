<script lang="ts">
  import { tabForKey } from "./tabs";

  type Tab = { id: string; label: string };

  let {
    tabs,
    selected = $bindable(),
    label,
  }: { tabs: Tab[]; selected: string; label: string } = $props();

  function onkeydown(event: KeyboardEvent & { currentTarget: HTMLElement }) {
    const next = tabForKey(
      tabs.map((tab) => tab.id),
      selected,
      event.key,
    );
    if (!next) return;
    event.preventDefault();
    selected = next;
    const target =
      event.currentTarget.parentElement?.children[tabs.findIndex((tab) => tab.id === next)];
    if (target instanceof HTMLElement) target.focus();
  }
</script>

<div class="tabs" role="tablist" aria-label={label}>
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      tabindex={tab.id === selected ? 0 : -1}
      aria-selected={tab.id === selected}
      class:selected={tab.id === selected}
      {onkeydown}
      onclick={() => (selected = tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 2rem;
  }
  button {
    min-height: var(--target);
    padding: 0;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 16px;
    cursor: pointer;
  }
  button.selected {
    border-bottom-color: var(--text);
    color: var(--text);
    font-weight: 500;
  }
</style>
