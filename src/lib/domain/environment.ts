// Test-only affordances (the local broker simulation, the e2e seeding routes) exist only where
// ENVIRONMENT is exactly "development" or "test". Unset or anything else, production included,
// counts as production, so a missing variable can never switch them on.
export function allowsTestAffordances(environment: string | undefined): boolean {
  return environment === "development" || environment === "test";
}
