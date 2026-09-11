import type { Command } from "commander";
import { buildOntologyView, ontologyMarkdown, ontologyRdf } from "@openfde/core";
import { fail, withLedger } from "../lib/helpers.js";

export function registerOntology(program: Command): void {
  program
    .command("ontology")
    .description(
      "The ontology as an artifact: what each type means, how populated it is, orphans and schema violations; --rdf exports RDF/OWL",
    )
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("--rdf", "export RDF/XML (OWL): classes, relations, individuals, facts with provenance")
    .option("--schema-only", "with --rdf: classes and relations only, no instances")
    .option("--json", "JSON output")
    .action((options: { engagement?: string; rdf?: boolean; schemaOnly?: boolean; json?: boolean }) => {
      try {
        if (options.rdf) {
          console.log(
            withLedger(options.engagement, (db, slug) =>
              ontologyRdf(db, slug, { schemaOnly: options.schemaOnly }),
            ),
          );
          return;
        }
        const { view, slug } = withLedger(options.engagement, (db, slug) => ({
          view: buildOntologyView(db),
          slug,
        }));
        if (options.json) console.log(JSON.stringify({ engagement: slug, ...view }));
        else console.log(ontologyMarkdown(view, slug));
      } catch (error) {
        fail(error);
      }
    });
}
