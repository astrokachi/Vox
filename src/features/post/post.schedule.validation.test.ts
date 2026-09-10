import { test } from "node:test";
import assert from "node:assert/strict";
import { schedulePostSchema } from "./post.validation.js";

test("schedulePostSchema validates message and future scheduledAt", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const { value, error } = schedulePostSchema.validate({
    message: "Hello later",
    scheduledAt: future,
  });
  assert.equal(error, undefined);
  assert.equal(value.message, "Hello later");
  assert.ok(value.scheduledAt instanceof Date);
});

test("schedulePostSchema rejects empty message", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const { error } = schedulePostSchema.validate({
    message: "",
    scheduledAt: future,
  });
  assert.notEqual(error, undefined);
});

test("schedulePostSchema rejects missing message", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const { error } = schedulePostSchema.validate({ scheduledAt: future });
  assert.notEqual(error, undefined);
});

test("schedulePostSchema rejects missing scheduledAt", () => {
  const { error } = schedulePostSchema.validate({ message: "Hello" });
  assert.notEqual(error, undefined);
});

test("schedulePostSchema rejects past scheduledAt", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { error } = schedulePostSchema.validate({
    message: "Hello",
    scheduledAt: past,
  });
  assert.notEqual(error, undefined);
});

test("schedulePostSchema rejects invalid scheduledAt", () => {
  const { error } = schedulePostSchema.validate({
    message: "Hello",
    scheduledAt: "not-a-date",
  });
  assert.notEqual(error, undefined);
});
