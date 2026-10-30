import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toTurn,
  buildRefinePrompt,
  deriveTitle,
  clampDraft,
  type GroupRow,
  type MessageRow,
} from "./chat.turns.js";
import { MAX_DRAFT_LENGTH } from "../../shared/const.js";

const msg = (over: Partial<MessageRow>): MessageRow => ({
  id: "m",
  conversation_id: "c1",
  message_group_id: "g1",
  role: "user",
  content: "",
  type: "SINGLE",
  created_at: new Date("2026-07-01T09:00:00Z"),
  ...over,
});

const group = (over: Partial<GroupRow>): GroupRow => ({
  id: "g1",
  conversation_id: "c1",
  parent_message_id: null,
  created_at: new Date("2026-07-01T09:00:00Z"),
  updated_at: new Date("2026-07-01T09:00:00Z"),
  ...over,
});

test("toTurn: MULTIPLE turn splits question from response options, ordered", () => {
  const g = group({ id: "g1" });
  const rows: MessageRow[] = [
    msg({ id: "a2", role: "assistant", type: "MULTIPLE", content: "opt2", created_at: new Date("2026-07-01T09:00:06Z") }),
    msg({ id: "q1", role: "user", type: "MULTIPLE", content: "make a post", created_at: new Date("2026-07-01T09:00:00Z") }),
    msg({ id: "a1", role: "assistant", type: "MULTIPLE", content: "opt1", created_at: new Date("2026-07-01T09:00:04Z") }),
  ];

  const turn = toTurn(g, rows);

  assert.equal(turn.turnId, "g1");
  assert.equal(turn.parentMessageId, null);
  assert.equal(turn.question?.id, "q1");
  assert.equal(turn.response.type, "MULTIPLE");
  assert.deepEqual(turn.response.options.map((o) => o.id), ["a1", "a2"]); // chronological
});

test("toTurn: SINGLE refine turn carries parentMessageId and one option", () => {
  const g = group({ id: "g2", parent_message_id: "a1" });
  const rows: MessageRow[] = [
    msg({ id: "q2", role: "user", type: "SINGLE", content: "make it punchier" }),
    msg({ id: "a3", role: "assistant", type: "SINGLE", content: "punchier draft", created_at: new Date("2026-07-01T09:05:03Z") }),
  ];

  const turn = toTurn(g, rows);

  assert.equal(turn.parentMessageId, "a1");
  assert.equal(turn.response.type, "SINGLE");
  assert.equal(turn.response.options.length, 1);
  assert.equal(turn.response.options[0].id, "a3");
});

test("toTurn: options carry their posted state, unposted ones null", () => {
  const sent = { x_post_id: "x1", content: "opt1", published_at: new Date("2026-07-01T10:00:00Z") };
  const rows: MessageRow[] = [
    msg({ id: "q1", role: "user", type: "MULTIPLE" }),
    msg({ id: "a1", role: "assistant", type: "MULTIPLE", created_at: new Date("2026-07-01T09:00:04Z") }),
    msg({ id: "a2", role: "assistant", type: "MULTIPLE", created_at: new Date("2026-07-01T09:00:05Z") }),
  ];

  const turn = toTurn(group({}), rows, new Map([["a1", sent]]));

  assert.deepEqual(turn.response.options.map((o) => o.posted), [sent, null]);
});

test("toTurn: pending turn (no assistant yet) has empty options", () => {
  const turn = toTurn(group({}), [msg({ id: "q1", role: "user", type: "MULTIPLE" })]);
  assert.equal(turn.response.type, "MULTIPLE");
  assert.deepEqual(turn.response.options, []);
});

test("buildRefinePrompt: embeds original draft and the instruction", () => {
  const p = buildRefinePrompt("original text", "make it shorter");
  assert.match(p, /ORIGINAL DRAFT:/);
  assert.match(p, /original text/);
  assert.match(p, /make it shorter/);
  assert.match(p, /Return ONLY the revised post/);
});

test("buildRefinePrompt: falls back when instruction is empty", () => {
  const p = buildRefinePrompt("original text", "   ");
  assert.match(p, /Improve this draft while keeping its meaning\./);
});

test("deriveTitle: short content is used as-is (whitespace collapsed)", () => {
  assert.equal(deriveTitle("  Create a post   about grit "), "Create a post about grit");
});

test("deriveTitle: long content is truncated at a word boundary with ellipsis", () => {
  const title = deriveTitle(
    "Create a compelling post about the grind of being a developer and shipping every day",
    60,
  );
  assert.ok(title.length <= 61, `title too long: ${title.length}`);
  assert.ok(title.endsWith("…"));
  assert.ok(!title.includes("  "));
});

test("deriveTitle: empty content falls back", () => {
  assert.equal(deriveTitle("   "), "New Conversation");
});

test("clampDraft: leaves drafts within the limit alone (trimmed)", () => {
  assert.equal(clampDraft("  short post  "), "short post");
  const exact = "a".repeat(MAX_DRAFT_LENGTH);
  assert.equal(clampDraft(exact), exact);
});

test("clampDraft: cuts long drafts at a word break within the limit", () => {
  const long = "word ".repeat(100).trim();
  const out = clampDraft(long);
  assert.ok(out.length <= MAX_DRAFT_LENGTH, `too long: ${out.length}`);
  assert.ok(out.endsWith("word"));
});

test("clampDraft: hard-cuts when there is no usable word break", () => {
  const out = clampDraft("x".repeat(400));
  assert.equal(out.length, MAX_DRAFT_LENGTH);
});

test("clampDraft: counts emoji as two characters, never splitting them", () => {
  const out = clampDraft("🔥".repeat(300));
  assert.equal(Array.from(out).length, MAX_DRAFT_LENGTH / 2);
});

test("clampDraft: counts a link as 23 characters however long it is", () => {
  const draft = `${"a".repeat(250)} https://example.com/${"x".repeat(100)}`;
  assert.equal(clampDraft(draft), draft);
});
