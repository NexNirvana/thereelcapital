// What the spike observed, per step and per (verify) item. Printed live as one line each and
// summarised in a markdown report that is turned into doc updates later.
import type { Redactor } from "./redact.ts";

export type Outcome = "PASS" | "FAIL" | "OBSERVED" | "NOT_OBSERVABLE" | "NOT_TESTED";

export interface Finding {
  readonly step: string;
  /** The (verify) item or open question this answers, e.g. "Q9 option TradeAction casing". */
  readonly item: string;
  readonly outcome: Outcome;
  readonly note: string;
}

export class Findings {
  readonly all: Finding[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly print: (line: string) => void,
  ) {}

  add(step: string, item: string, outcome: Outcome, note: string): void {
    const finding = {
      step,
      item,
      outcome,
      note: this.redactor.text(note),
    };
    this.all.push(finding);
    this.print(`${outcome.padEnd(14)} [${step}] ${item}: ${finding.note}`);
  }
}

export function renderReport(
  findings: readonly Finding[],
  meta: { date: string; symbol: string },
): string {
  const lines = [
    "# SIM spike report (#21)",
    "",
    `Run: ${meta.date}. Underlying: ${meta.symbol}. SIM only. Raw samples: engine/test/fixtures/sim/<step>/.`,
    "",
    "Turn each row into an update of `docs/tradestation-integration.md` (replace the matching **(verify)**) and `docs/open-questions.md` (items 6 to 12).",
    "",
    "| Outcome | Step | Item | Observation |",
    "| --- | --- | --- | --- |",
    ...findings.map(
      (finding) =>
        `| ${finding.outcome} | ${finding.step} | ${cell(finding.item)} | ${cell(finding.note)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
