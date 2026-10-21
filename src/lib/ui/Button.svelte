<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

  type Common = { variant?: "primary" | "outline" | "link"; children: Snippet };
  // A link cannot be disabled, so `href` and `disabled` never combine.
  type Props =
    | (Common & { href: string } & Omit<HTMLAnchorAttributes, "children" | "type">)
    | (Common & { href?: undefined } & Omit<HTMLButtonAttributes, "children">);

  let { variant = "outline", children, class: className, ...rest }: Props = $props();
</script>

{#if rest.href !== undefined}
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass hrefs already built with resolve() -->
  <a class={["button", variant, className]} {...rest}>
    {@render children()}{#if variant !== "outline"}<span aria-hidden="true">→</span>{/if}
  </a>
{:else}
  <button class={["button", variant, className]} {...rest}>
    {@render children()}{#if variant === "primary"}<span aria-hidden="true">→</span>{/if}
  </button>
{/if}

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: var(--target);
    padding: 0 1rem;
    border: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .primary {
    width: 100%;
    min-height: 56px;
    background: var(--text);
    color: var(--on-primary);
    font-size: 17px;
    font-weight: 600;
  }
  .outline {
    border-color: var(--text);
  }
  .link {
    justify-content: flex-start;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .button:disabled {
    background: var(--done);
    border-color: var(--rule);
    color: var(--text-dim);
    cursor: not-allowed;
  }
</style>
