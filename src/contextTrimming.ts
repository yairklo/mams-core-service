/**
 * Token-saving trims for multi-step agent turns: drop stale tool payloads from LLM context.
 */

import type { ModelMessage } from "ai";

export const MAX_RECENT_TOOL_TURNS = 4;
export const MAX_CODER_PRIOR_STEPS = 4;

const SLIM_OUTPUT_MAX_CHARS = 240;

function asToolResultOutput(output: unknown): ModelMessage extends never ? never : import("@ai-sdk/provider").LanguageModelV2ToolResultOutput {
  return output as import("@ai-sdk/provider").LanguageModelV2ToolResultOutput;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function isToolResultPart(part: unknown): part is { type: "tool-result"; toolCallId: string; toolName: string; output: unknown } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: string }).type === "tool-result" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isToolCallPart(part: unknown): part is { type: "tool-call"; toolCallId: string; toolName: string; input: unknown } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: string }).type === "tool-call" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function collectToolResultIds(messages: readonly ModelMessage[]): readonly string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolResultPart(part)) {
          ids.push(part.toolCallId);
        }
      }
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolResultPart(part)) {
          ids.push(part.toolCallId);
        }
      }
    }
  }
  return ids;
}

function slimToolResultOutput(toolName: string, output: unknown): unknown {
  if (toolName === "read_file") {
    const record = output as { path?: string; content?: string; totalChars?: number; truncated?: boolean };
    const totalChars = record.totalChars ?? record.content?.length ?? 0;
    return {
      path: record.path,
      content: `[omitted ${totalChars} chars from an earlier read_file turn — call read_file again if you need the file]`,
      totalChars,
      truncated: record.truncated,
      omitted: true,
    };
  }

  if (toolName === "write_file") {
    const record = output as { path?: string; bytesWritten?: number; verifiedReadBack?: boolean };
    return {
      path: record.path,
      bytesWritten: record.bytesWritten,
      verifiedReadBack: record.verifiedReadBack,
      omitted: true,
    };
  }

  if (toolName === "run_local_tests") {
    const record = output as {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      durationMs?: number;
    };
    return {
      exitCode: record.exitCode,
      timedOut: record.timedOut,
      durationMs: record.durationMs,
      stdout: truncateText(record.stdout ?? "", SLIM_OUTPUT_MAX_CHARS),
      stderr: truncateText(record.stderr ?? "", SLIM_OUTPUT_MAX_CHARS),
      omitted: true,
    };
  }

  if (toolName === "list_repo_structure") {
    const record = output as { tree?: string; fileCount?: number };
    return {
      fileCount: record.fileCount,
      tree: truncateText(record.tree ?? "", SLIM_OUTPUT_MAX_CHARS),
      omitted: true,
    };
  }

  if (toolName === "read_file_slice") {
    const record = output as { path?: string; startLine?: number; endLine?: number; totalLines?: number };
    return {
      path: record.path,
      startLine: record.startLine,
      endLine: record.endLine,
      totalLines: record.totalLines,
      content: "[omitted slice content from earlier turn — call read_file_slice again if needed]",
      omitted: true,
    };
  }

  if (toolName === "search_files") {
    const record = output as { query?: string; matches?: unknown[]; truncated?: boolean; filesScanned?: number };
    return {
      query: record.query,
      matchCount: record.matches?.length ?? 0,
      truncated: record.truncated,
      filesScanned: record.filesScanned,
      omitted: true,
    };
  }

  return output;
}

function slimToolCallInput(toolName: string, input: unknown): unknown {
  if (toolName !== "write_file" || typeof input !== "object" || input === null) {
    return input;
  }
  const record = input as { path?: string; content?: string };
  if (typeof record.content !== "string" || record.content.length <= SLIM_OUTPUT_MAX_CHARS) {
    return input;
  }
  return {
    path: record.path,
    content: `[omitted ${record.content.length} chars from an earlier write_file call]`,
    omitted: true,
  };
}

/** Keeps full payloads only for the most recent N tool-result turns. */
export function trimMessagesForNextStep(
  messages: readonly ModelMessage[],
  keepRecentToolTurns: number = MAX_RECENT_TOOL_TURNS
): ModelMessage[] {
  const toolResultIds = collectToolResultIds(messages);
  const recentIds = new Set(toolResultIds.slice(-keepRecentToolTurns));

  return messages.map((message) => {
    if (message.role === "tool" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => {
          if (!isToolResultPart(part) || recentIds.has(part.toolCallId)) {
            return part;
          }
          return {
            ...part,
            output: asToolResultOutput(slimToolResultOutput(part.toolName, part.output)),
          };
        }),
      };
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => {
          if (isToolResultPart(part) && !recentIds.has(part.toolCallId)) {
            return {
              ...part,
              output: asToolResultOutput(slimToolResultOutput(part.toolName, part.output)),
            };
          }
          if (isToolCallPart(part) && !recentIds.has(part.toolCallId)) {
            return {
              ...part,
              input: slimToolCallInput(part.toolName, part.input),
            };
          }
          return part;
        }),
      };
    }

    return message;
  });
}

export function createPrepareStepTrimmer(keepRecentToolTurns: number = MAX_RECENT_TOOL_TURNS) {
  return ({ messages }: { messages: readonly ModelMessage[] }) => ({
    messages: trimMessagesForNextStep(messages, keepRecentToolTurns),
  });
}
