<script lang="ts">
  let { label }: { label: string } = $props();
</script>

<span class="badge">{label}</span>

<style>
  .badge {
    display: inline-block;
    padding: 0.125rem 0.625rem;
    border: 1px solid var(--rule-strong);
    background: var(--bg);
    color: var(--text);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
