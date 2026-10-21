<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<h1>Operar</h1>
<p class="smoke">engine: <output data-testid="ping">{data.ping}</output></p>

<style>
  h1 {
    font-size: clamp(28px, 4vw, 40px);
  }
  .smoke {
    color: var(--text-dim);
  }
</style>
