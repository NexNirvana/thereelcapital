// Set only while CREDENTIALS_KEY is being rotated (docs/runbook.md#secrets); not in
// `secrets.required`, so `wrangler types` does not know it.
interface EngineEnv {
  CREDENTIALS_KEY_PREVIOUS?: string;
}
