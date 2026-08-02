export const repositoryQuestionCategories = [
  "semantic",
  "exact_symbol",
  "file_specific",
  "architecture",
  "dependency",
  "usage",
  "configuration",
  "database",
  "api_flow",
] as const;

export type RepositoryQuestionCategory =
  (typeof repositoryQuestionCategories)[number];

const filePathPattern =
  /(?:^|[\s`'"(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+(?=$|[\s`'"),?!])/iu;
const exactSymbolIntentPattern =
  /(?:where\s+is|find|used?|defined?|references?|calls?)\s+[`'"]*([A-Za-z_$][\w$]*(?:\(\))?)/iu;

export function extractExactSymbolName(question: string): string | undefined {
  const quoted = /`([A-Za-z_$][\w$]*)`/u.exec(question)?.[1];
  if (quoted !== undefined) {
    return quoted;
  }
  const candidate = exactSymbolIntentPattern.exec(question)?.[1];
  if (
    candidate === undefined ||
    !/[A-Z_$]|[a-z][A-Z]|\(\)$/u.test(candidate)
  ) {
    return undefined;
  }
  return candidate.replace(/\(\)$/u, "");
}

function namesCodeLikeSymbol(question: string): boolean {
  return extractExactSymbolName(question) !== undefined;
}

export function classifyRepositoryQuestion(
  question: string,
): RepositoryQuestionCategory {
  const normalized = question.trim().toLowerCase();

  if (filePathPattern.test(question)) {
    return "file_specific";
  }
  if (namesCodeLikeSymbol(question)) {
    return "exact_symbol";
  }
  if (/\b(architecture|end[- ]to[- ]end|complete (?:request )?flow|overall design)\b/u.test(normalized)) {
    return "architecture";
  }
  if (/\b(dependency|dependencies|depends on|imports?|requires?)\b/u.test(normalized)) {
    return "dependency";
  }
  if (/\b(route|endpoint|request flow|api flow|middleware|controller)\b/u.test(normalized)) {
    return "api_flow";
  }
  if (/\b(database|schema|model|mongodb|mongoose|sql|query)\b/u.test(normalized)) {
    return "database";
  }
  if (/\b(config|configuration|environment|env var|setting)\b/u.test(normalized)) {
    return "configuration";
  }
  if (/\b(usage|how (?:do|can|should) i use|example)\b/u.test(normalized)) {
    return "usage";
  }

  return "semantic";
}
