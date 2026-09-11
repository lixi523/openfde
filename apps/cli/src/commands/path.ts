import type { Command } from "commander";
import { findPath, pathMarkdown } from "@openfde/core";
import { fail, withLedger } from "../lib/helpers.js";

export function registerPath(program: Command): void {
  program
    .command("path <from> <to>")
    .description("Shortest chain of cited facts connecting two entities (names, case-insensitive)")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("--json", "JSON output")
    .action((from: string, to: string, options: { engagement?: string; json?: boolean }) => {
      try {
        const result = withLedger(options.engagement, (db) => findPath(db, from, to));
        if (options.json) console.log(JSON.stringify({ from, to, path: result }));
        else console.log(pathMarkdown(result, from, to));
      } catch (error) {
        fail(error);
      }
    });
}
