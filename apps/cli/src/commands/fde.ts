import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { buildFdeDoc, extractCustomBlock, fdeMarkdown } from "@openfde/core";
import { fail, withLedger } from "../lib/helpers.js";

export function registerFde(program: Command): void {
  program
    .command("fde")
    .description(
      "FDE.md — the deployment brief every agent reads first: who we serve, mission, hard constraints, trusted data, people, decisions, and the memory/work protocol (spec: https://fde.md)",
    )
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("-w, --write [path]", "write to a file (default ./FDE.md), preserving the FDE's custom notes block")
    .option("--json", "JSON output")
    .action((options: { engagement?: string; write?: string | boolean; json?: boolean }) => {
      try {
        const target =
          options.write === undefined || options.write === false
            ? null
            : resolve(typeof options.write === "string" ? options.write : "FDE.md");
        const existing = target && existsSync(target) ? readFileSync(target, "utf8") : null;
        const doc = withLedger(options.engagement, (db, slug) =>
          buildFdeDoc(db, slug, { custom: extractCustomBlock(existing) }),
        );
        if (options.json) {
          console.log(JSON.stringify(doc));
          return;
        }
        const markdown = fdeMarkdown(doc);
        if (target) {
          writeFileSync(target, markdown + "\n");
          console.log(`Wrote ${target} (${doc.totals.facts} facts, ${doc.constraints.length} constraints${doc.custom ? ", custom notes kept" : ""}).`);
          console.log("Point your agents at it: add `@FDE.md` to CLAUDE.md, or \"Read FDE.md first\" to AGENTS.md.");
          return;
        }
        console.log(markdown);
      } catch (error) {
        fail(error);
      }
    });
}
