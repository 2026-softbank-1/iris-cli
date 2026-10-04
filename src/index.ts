import { CommanderError } from "commander";
import { buildProgram } from "./cli.js";
import { reportCommanderError, reportError, wantsJson } from "./lib/report.js";

const json = wantsJson(process.argv.slice(2));

try {
  await buildProgram({ quietParseErrors: json }).parseAsync();
} catch (error) {
  if (error instanceof CommanderError) process.exit(reportCommanderError(error, { json }));
  const exitCode = reportError(error, { json });
  if (exitCode === undefined) throw error;
  process.exit(exitCode);
}
