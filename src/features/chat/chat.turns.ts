import twitter from "twitter-text";
import { messages, messageGroups } from "../../shared/db/schema.js";
import { MAX_DRAFT_LENGTH } from "../../shared/const.js";

export type ChatType = "SINGLE" | "MULTIPLE";
export type MessageRow = typeof messages.$inferSelect;
export type GroupRow = typeof messageGroups.$inferSelect;

/** The latest time a draft was published to X. */
export interface PostedState {
  x_post_id: string | null;
  // The text that went out; the user can edit a draft before posting it.
  content: string;
  published_at: Date;
}

/** A response option, with whether it has been published. */
export type DraftRow = MessageRow & { posted: PostedState | null };

/**
 * A turn = one question (user message) + its response variants (assistant
 * messages), assembled from a single MessageGroup.
 */
export interface Turn {
  turnId: string;
  parentMessageId: string | null;
  question: MessageRow | null;
  response: {
    type: ChatType;
    options: DraftRow[];
  };
}

/**
 * Assemble a turn from its group and the messages that belong to it.
 * `posted` maps a draft's id to its published state; drafts not in it are unposted.
 */
export function toTurn(
  group: GroupRow,
  groupMessages: MessageRow[],
  posted: ReadonlyMap<string, PostedState> = new Map(),
): Turn {
  const ordered = [...groupMessages].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const question = ordered.find((m) => m.role === "user") ?? null;
  const options = ordered
    .filter((m) => m.role === "assistant")
    .map((m) => ({ ...m, posted: posted.get(m.id) ?? null }));

  return {
    turnId: group.id,
    parentMessageId: group.parent_message_id ?? null,
    question,
    response: {
      type: (question?.type as ChatType) ?? "SINGLE",
      options,
    },
  };
}

/** Derive a short conversation title from the first prompt's content. */
export function deriveTitle(content: string, maxLen = 60): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Conversation";
  if (cleaned.length <= maxLen) return cleaned;

  const slice = cleaned.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed.trimEnd()}…`;
}

/**
 * Hard cap for a generated draft, in case the model ignores the length rule.
 * Length is measured by X's own counter (emoji and CJK count as 2, every link
 * as 23, MAX_DRAFT_LENGTH in all); the draft is cut at the last word break
 * that fits, not mid-word.
 */
export function clampDraft(text: string): string {
  const trimmed = text.trim();
  const parsed = twitter.parseTweet(trimmed);
  if (parsed.weightedLength <= MAX_DRAFT_LENGTH) return trimmed;

  // validRangeEnd is the index of the last character that still fits.
  const slice = trimmed.slice(0, parsed.validRangeEnd + 1);
  const lastBreak = slice.search(/\s\S*$/);
  const cut = lastBreak > slice.length / 2 ? slice.slice(0, lastBreak) : slice;
  return cut.trimEnd();
}

/** Compose the LLM prompt for a refinement: original draft + user request. */
export function buildRefinePrompt(original: string, instruction: string): string {
  const request = instruction.trim().length
    ? instruction.trim()
    : "Improve this draft while keeping its meaning.";

  return [
    "You are refining an existing social media post draft.",
    "",
    "ORIGINAL DRAFT:",
    '"""',
    original,
    '"""',
    "",
    "USER REQUEST:",
    '"""',
    request,
    '"""',
    "",
    "Rewrite the draft so it satisfies the request. Keep it natural, concise,",
    "and ready to post. Return ONLY the revised post — no preamble, no quotes,",
    "no multiple options.",
  ].join("\n");
}
