import type { TaskId } from "./types.js";
import {
  filterMeaningfulPaths,
  normalizeRepoPath,
  slugifyBranchSegment,
} from "./workspaceGit.js";

const MAX_BRANCH_SLUG_LEN = 48;
const BRANCH_PREFIX = "mams";
const MAX_SUBJECT_LEN = 72;

const FEATURE_KEYWORDS: readonly { readonly pattern: RegExp; readonly slug: string }[] = [
  { pattern: /notification|notify|push|alert|התרא/i, slug: "notifications" },
  { pattern: /join(?:ed|s|ing)?|הצטרפ/i, slug: "game-join" },
  { pattern: /chat|message|הודע/i, slug: "chat" },
  { pattern: /i18n|locale|translation|תרגום/i, slug: "i18n" },
];

const HEBREW_ACTION_TO_ENGLISH: Readonly<Record<string, string>> = {
  "להחליף": "rename",
  "לשנות": "update",
  "להוסיף": "add",
  "למחוק": "remove",
  "לתקן": "fix",
  "לעדכן": "update",
  "הוספת": "add",
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

export function slugifyForGit(input: string): string {
  return slugifyBranchSegment(input.slice(0, MAX_BRANCH_SLUG_LEN));
}

function shortTaskSuffix(taskId: TaskId): string {
  return taskId.replace(/-/g, "").slice(0, 8);
}

function hasSignificantAscii(text: string): boolean {
  const ascii = text.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  return ascii.length >= 12;
}

function inferHebrewAction(objective: string): string | null {
  for (const [hebrew, english] of Object.entries(HEBREW_ACTION_TO_ENGLISH)) {
    if (objective.includes(hebrew)) {
      return english;
    }
  }
  return null;
}

function inferFeatureSlug(objective: string, acceptanceCriteria: readonly string[]): string | null {
  const corpus = [objective, ...acceptanceCriteria].join("\n");
  for (const { pattern, slug } of FEATURE_KEYWORDS) {
    if (pattern.test(corpus)) {
      return slug;
    }
  }
  return null;
}

function slugFromChangedPaths(changedPaths: readonly string[]): string | null {
  const meaningful = filterMeaningfulPaths(changedPaths.map(normalizeRepoPath));
  if (meaningful.length === 0) {
    return null;
  }

  const normalized = meaningful.map(normalizeRepoPath);
  const localePath = normalized.find((path) => /locales?\/[^/]+\.(json|ya?ml)$/i.test(path));
  if (localePath) {
    const locale = localePath.match(/locales?\/([^/.]+)\./i)?.[1] ?? "locale";
    const area = normalized.some((path) => /mobile/i.test(path)) ? "mobile" : "app";
    return slugifyForGit(`${area}-i18n-${locale}`);
  }

  const featureFromPaths = normalized.some((p) => /notification/i.test(p))
    ? "notifications"
    : normalized.some((p) => /chat|message/i.test(p))
      ? "chat"
      : null;
  if (featureFromPaths) {
    return slugifyForGit(`feat-${featureFromPaths}`);
  }

  const primary = normalized[0] ?? "";
  const segments = primary
    .split("/")
    .filter((segment) => segment.length > 0 && !["src", "dist", "lib", "app"].includes(segment.toLowerCase()));
  const tail = segments.slice(-2).join("-");
  return tail ? slugifyForGit(tail) : null;
}

function slugFromObjective(objective: string, acceptanceCriteria: readonly string[]): string | null {
  const feature = inferFeatureSlug(objective, acceptanceCriteria);
  if (feature) {
    return slugifyForGit(`feat-${feature}`);
  }

  const action = inferHebrewAction(objective);
  if (action) {
    return slugifyForGit(action);
  }

  const asciiWords = objective
    .replace(/[^\x20-\x7E]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((word) => word.length > 2)
    .slice(0, 5);
  if (asciiWords.length > 0) {
    return slugifyForGit(asciiWords.join("-"));
  }
  return null;
}

export function buildBranchName(
  taskId: TaskId,
  objective: string,
  acceptanceCriteria: readonly string[],
  changedPaths: readonly string[]
): string {
  const meaningful = filterMeaningfulPaths(changedPaths);
  const slug =
    slugFromChangedPaths(meaningful.length > 0 ? meaningful : changedPaths) ??
    slugFromObjective(objective, acceptanceCriteria) ??
    "change";
  return `${BRANCH_PREFIX}/${slug}-${shortTaskSuffix(taskId)}`;
}

function inferCommitType(changedPaths: readonly string[]): string {
  const paths = filterMeaningfulPaths(changedPaths);
  if (paths.some((path) => /locales?|i18n|translation/i.test(path))) {
    return "fix";
  }
  if (paths.some((path) => /test|spec|__tests__/i.test(path))) {
    return "test";
  }
  if (paths.some((path) => /\.md$/i.test(path) || /\/docs\//i.test(path))) {
    return "docs";
  }
  return "feat";
}

function inferCommitScope(changedPaths: readonly string[]): string {
  const paths = filterMeaningfulPaths(changedPaths);
  const hasMobile = paths.some((path) => /mobile_app|mobile-app/i.test(path));
  const hasServer = paths.some((path) => /(?:^|\/)server(?:\/|$)/i.test(path));
  if (hasMobile && hasServer) {
    return "app";
  }
  if (hasMobile) {
    return "mobile";
  }
  if (hasServer) {
    return "server";
  }
  if (paths.some((path) => /next_app|next-app/i.test(path))) {
    return "web";
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

function summarizeAcceptanceCriterion(criterion: string): string {
  const cleaned = criterion.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) {
    return cleaned;
  }
  return `${cleaned.slice(0, 57)}...`;
}

function buildCommitSubject(input: GitMetadataInput): string {
  const meaningful = filterMeaningfulPaths(input.changedPaths);
  const paths = meaningful.length > 0 ? meaningful : input.changedPaths;
  const type = inferCommitType(paths);
  const scope = inferCommitScope(paths);
  const feature = inferFeatureSlug(input.objective, input.acceptanceCriteria);

  if (feature === "notifications" || feature === "game-join") {
    return `${type}(${scope}): notify owner when player joins game`;
  }
  if (feature === "chat") {
    return `${type}(${scope}): add direct chat actions for joined players`;
  }

  const keyHint = extractChangedKeyFromDiff(input.diffText);
  const localePath = paths.find((path) => /locales?\/[^/]+\./i.test(path));
  const locale = localePath?.match(/locales?\/([^/.]+)\./i)?.[1];
  if (locale && keyHint) {
    return `${type}(${scope}): update ${locale} ${keyHint} label`;
  }
  if (locale) {
    return `${type}(${scope}): update ${locale} UI strings`;
  }

  const englishCriterion = input.acceptanceCriteria.find((c) => hasSignificantAscii(c));
  if (englishCriterion) {
    return `${type}(${scope}): ${summarizeAcceptanceCriterion(englishCriterion)}`;
  }

  if (hasSignificantAscii(input.objective)) {
    const asciiObjective = input.objective.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
    return `${type}(${scope}): ${asciiObjective.slice(0, MAX_SUBJECT_LEN - type.length - scope.length - 4)}`;
  }

  const action = inferHebrewAction(input.objective);
  if (action === "add" && feature) {
    return `${type}(${scope}): add ${feature.replace(/-/g, " ")} feature`;
  }
  if (action) {
    return `${type}(${scope}): ${action} per task objective`;
  }

  return `${type}(${scope}): implement task objective`;
}

export function buildCommitMessage(input: GitMetadataInput): GitCommitMessage {
  const meaningful = filterMeaningfulPaths(input.changedPaths);
  const pathsForBody = meaningful.length > 0 ? meaningful : input.changedPaths;
  const subject = buildCommitSubject({ ...input, changedPaths: pathsForBody }).slice(0, MAX_SUBJECT_LEN);
  const bodyLines: string[] = [];

  if (pathsForBody.length > 0) {
    bodyLines.push("Changes:");
    for (const path of pathsForBody.slice(0, 12)) {
      bodyLines.push(`- ${path}`);
    }
  }

  bodyLines.push("", "Task objective:", input.objective);
  if (input.acceptanceCriteria.length > 0) {
    bodyLines.push("", "Acceptance criteria:");
    for (const criterion of input.acceptanceCriteria.slice(0, 6)) {
      bodyLines.push(`- ${criterion}`);
    }
  }

  if (input.coderSummary?.trim()) {
    bodyLines.push("", "Implementation notes:", input.coderSummary.trim().slice(0, 800));
  }

  const body = bodyLines.join("\n");
  return { subject, body, message: `${subject}\n\n${body}` };
}

export function buildGitMetadata(input: GitMetadataInput): GitMetadata {
  const meaningful = filterMeaningfulPaths(input.changedPaths);
  const pathsForMeta = meaningful.length > 0 ? meaningful : input.changedPaths;
  return {
    branch: buildBranchName(input.taskId, input.objective, input.acceptanceCriteria, pathsForMeta),
    commit: buildCommitMessage({ ...input, changedPaths: pathsForMeta }),
  };
}
