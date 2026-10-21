<script lang="ts">
  // Render inside a <dl>; each row is a <div> group of <dt>/<dd>.
  let { label, value }: { label: string; value: string } = $props();
</script>

<div class="row">
  <dt>{label}</dt>
  <dd>{value}</dd>
</div>

<style>
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--rule);
  }
  dt {
    flex: none;
    color: var(--text);
  }
  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    font-weight: 500;
    text-align: right;
  }
</style>
