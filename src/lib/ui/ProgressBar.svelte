<script lang="ts">
  let { value, label }: { value: number; label: string } = $props();
  const percent = $derived(Math.min(100, Math.max(0, value)));
</script>

<div class="progress">
  <div
    class="track"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={percent}
    aria-label={label}
  >
    <div class="fill" style:width="{percent}%"></div>
  </div>
  <span class="label">{label}</span>
</div>

<style>
  .progress {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .track {
    flex: 1;
    height: 4px;
    background: var(--rule);
  }
  .fill {
    height: 100%;
    background: var(--text);
  }
  .label {
    color: var(--text-muted);
  }
</style>
