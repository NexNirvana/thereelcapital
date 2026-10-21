<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<h1>REEL CAPITAL</h1>
<p>engine: <output data-testid="ping">{data.ping}</output></p>
