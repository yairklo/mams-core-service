import type { TaskId } from "./types.js";

const MAX_BRANCH_SLUG_LEN = 48;
const BRANCH_PREFIX = "mams";
const MAX_SUBJECT_LEN = 72;

const HEBREW_ACTION_TO_ENGLISH: Readonly<Record<string, string>> = {
  "להחליף": "rename",
  "לשנות": "update",
  "להוסיף": "add",
  "למחוק": "remove",
  "לתקן": "fix",
  "לעדכן": "update",
};

export interface GitMetadataInput {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly changedPaths: readonly string[];
  readonly diffText?: string;
  readonly coderSummary?: string | null;
}

export interface GitCommitMessage {
  readonly subject: string;
  readonly body: string;
  readonly message: string;
}

export interface GitMetadata {
  readonly branch: string;
  readonly commit: GitCommitMessage;
}

/** Parses `git status --porcelain` paths (pre-add). */
export function parseChangedPathsFromPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 4) {
      continue;
    }
    const pathPart = trimmed.slice(3).trim();
    if (!pathPart) {
      continue;
    }
    const renamed = pathPart.includes(" -> ") ? (pathPart.split(" -> ").pop() ?? pathPart) : pathPart;
    paths.push(renamed.replace(/\\/g, "/"));
  }
  return [...new Set(paths)];
}

export function slugifyBranchSegment(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG_LEN);
  return slug.length > 0 ? slug : "change";
}

function shortTaskSuffix(taskId: TaskId): string {
  return taskId.replace(/-/g, "").slice(0, 8);
}

function inferHebrewAction(objective: string): string | null {
  for (const [hebrew, english] of Object.entries(HEBREW_ACTION_TO_ENGLISH)) {
    if (objective.includes(hebrew)) {
      return english;
    }
  }
  return null;
}

function extractQuotedStrings(text: string): string[] {
  const matches = [...text.matchAll(/["'""]([^"'""]+)["'""]/g)];
  return matches.map((match) => match[1]?.trim() ?? "").filter((value) => value.length > 0);
}

function slugFromChangedPaths(changedPaths: readonly string[]): string | null {
  if (changedPaths.length === 0) {
    return null;
  }

  const normalized = changedPaths.map((path) => path.replace(/\\/g, "/"));
  const localePath = normalized.find((path) => /locales?\/[^/]+\.(json|ya?ml)$/i.test(path));
  if (localePath) {
    const locale = localePath.match(/locales?\/([^/.]+)\./i)?.[1] ?? "locale";
    const area = normalized.some((path) => /mobile/i.test(path)) ? "mobile" : "app";
    return slugifyBranchSegment(`${area}-i18n-${locale}`);
  }

  if (normalized.some((path) => /i18n|translation|locale/i.test(path))) {
    return slugifyBranchSegment("i18n-update");
  }

  const primary = normalized[0] ?? "";
  const segments = primary
    .split("/")
    .filter((segment) => segment.length > 0 && !["src", "dist", "lib", "app"].includes(segment.toLowerCase()));
  const tail = segments.slice(-2).join("-");
  return tail ? slugifyBranchSegment(tail) : null;
}

function slugFromObjective(objective: string): string | null {
  const action = inferHebrewAction(objective);
  const quoted = extractQuotedStrings(objective);
  if (action && quoted.length >= 2) {
    return slugifyBranchSegment(`${action}-label`);
  }
  if (action) {
    return slugifyBranchSegment(action);
  }

  const asciiWords = objective
    .replace(/[^\x20-\x7E]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((word) => word.length > 2)
    .slice(0, 5);
  if (asciiWords.length > 0) {
    return slugifyBranchSegment(asciiWords.join("-"));
  }
  return null;
}

export function buildBranchName(taskId: TaskId, objective: string, changedPaths: readonly string[]): string {
  const slug = slugFromChangedPaths(changedPaths) ?? slugFromObjective(objective) ?? "change";
  return `${BRANCH_PREFIX}/${slug}-${shortTaskSuffix(taskId)}`;
}

function inferCommitType(changedPaths: readonly string[]): string {
  if (changedPaths.some((path) => /locales?|i18n|translation/i.test(path))) {
    return "fix";
  }
  if (changedPaths.some((path) => /test|spec|__tests__/i.test(path))) {
    return "test";
  }
  if (changedPaths.some((path) => /\.md$/i.test(path) || /\/docs\//i.test(path))) {
    return "docs";
  }
  if (changedPaths.some((path) => /package\.json|lock\.json|pnpm-lock|yarn\.lock/i.test(path))) {
    return "chore";
  }
  return "feat";
}

function inferCommitScope(changedPaths: readonly string[]): string {
  if (changedPaths.some((path) => /mobile_app|mobile-app/i.test(path))) {
    return "mobile";
  }
  if (changedPaths.some((path) => /(?:^|\/)server(?:\/|$)/i.test(path))) {
    return "server";
  }
  if (changedPaths.some((path) => /next_app|next-app/i.test(path))) {
    return "web";
  }
  if (changedPaths.some((path) => /locales?|i18n/i.test(path))) {
    return "i18n";
  }
  return "mams";
}

function extractChangedKeyFromDiff(diffText?: string): string | null {
  if (!diffText) {
    return null;
  }
  for (const line of diffText.split("\n")) {
    const keyMatch = line.match(/^[+-]\s*"([^"]+)":/);
    if (keyMatch?.[1]) {
      return keyMatch[1];
    }
  }
  return null;
}

function buildCommitSubject(input: GitMetadataInput): string {
  const type = inferCommitType(input.changedPaths);
  const scope = inferCommitScope(input.changedPaths);
  const keyHint = extractChangedKeyFromDiff(input.diffText);
  const localePath = input.changedPaths.find((path) => /locales?\/[^/]+\./i.test(path));
  const locale = localePath?.match(/locales?\/([^/.]+)\./i)?.[1];

  if (locale && keyHint) {
    return `${type}(${scope}): update ${locale} ${keyHint} label`;
  }
  if (locale) {
    return `${type}(${scope}): update ${locale} UI strings`;
  }

  const asciiObjective = input.objective.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  if (asciiObjective.length >= 12) {
    return `${type}(${scope}): ${asciiObjective.slice(0, MAX_SUBJECT_LEN - type.length - scope.length - 4)}`;
  }

  const action = inferHebrewAction(input.objective);
  const quoted = extractQuotedStrings(input.objective);
  if (action === "rename" && quoted.length >= 2) {
    return `${type}(${scope}): rename homepage label text`;
  }
  if (action) {
    return `${type}(${scope}): ${action} per task objective`;
  }

  const primaryFile = input.changedPaths[0]?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "files";
  return `${type}(${scope}): update ${primaryFile}`;
}

export function buildCommitMessage(input: GitMetadataInput): GitCommitMessage {
  const subject = buildCommitSubject(input).slice(0, MAX_SUBJECT_LEN);
  const bodyLines: string[] = [];

  if (input.changedPaths.length > 0) {
    bodyLines.push("Changes:");
    for (const path of input.changedPaths.slice(0, 12)) {
      bodyLines.push(`- ${path}`);
    }
  }

  const objectiveLine = input.acceptanceCriteria[0] ?? input.objective;
  bodyLines.push("", "Task objective:", objectiveLine);

  if (input.coderSummary?.trim()) {
    bodyLines.push("", "Implementation notes:", input.coderSummary.trim().slice(0, 800));
  }

  const body = bodyLines.join("\n");
  return { subject, body, message: `${subject}\n\n${body}` };
}

export function buildGitMetadata(input: GitMetadataInput): GitMetadata {
  return {
    branch: buildBranchName(input.taskId, input.objective, input.changedPaths),
    commit: buildCommitMessage(input),
  };
}
