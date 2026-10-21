<script lang="ts">
  import "#lib/ui/tokens.css";
  import "#lib/ui/base.css";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();
</script>

{@render children()}
