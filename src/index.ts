import { buildProgram } from "./cli.js";
import { CliError } from "./lib/errors.js";

try {
  await buildProgram().parseAsync();
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  throw error;
}
