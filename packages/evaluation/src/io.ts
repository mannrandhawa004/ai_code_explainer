import { readFile, stat, writeFile } from "node:fs/promises";

import { EvaluationValidationError } from "./validation.js";

const maximumEvaluationJsonBytes = 25 * 1024 * 1024;

export async function readEvaluationJsonFile(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      throw new Error("Path is not a regular file");
    }
    if (file.size > maximumEvaluationJsonBytes) {
      throw new EvaluationValidationError(
        `Evaluation JSON file exceeds ${maximumEvaluationJsonBytes} bytes: ${filePath}`,
      );
    }
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof EvaluationValidationError) {
      throw error;
    }
    throw new EvaluationValidationError(
      `Could not read evaluation JSON file: ${filePath}`,
      { cause: error },
    );
  }
  if (Buffer.byteLength(contents, "utf8") > maximumEvaluationJsonBytes) {
    throw new EvaluationValidationError(
      `Evaluation JSON file exceeds ${maximumEvaluationJsonBytes} bytes: ${filePath}`,
    );
  }
  try {
    return JSON.parse(contents.replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw new EvaluationValidationError(
      `Evaluation JSON file is malformed: ${filePath}`,
      { cause: error },
    );
  }
}

export async function writeEvaluationReportFile(
  filePath: string,
  report: unknown,
  pretty = false,
): Promise<void> {
  const serialized = `${JSON.stringify(report, null, pretty ? 2 : undefined)}\n`;
  await writeFile(filePath, serialized, { encoding: "utf8", flag: "w" });
}
