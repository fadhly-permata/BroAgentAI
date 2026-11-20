import { test } from "node:test";
import assert from "node:assert/strict";
import { addCoAuthorTrailers, BUILT_IN_CO_AUTHORS, commitCoAuthors, isCoAuthor, normalizeCoAuthors } from "./co-authors.ts";

const FADHLY = "Fadhly Permata <8925077+fadhly-permata@users.noreply.github.com>";

test("isCoAuthor accepts Name <email> only", () => {
  assert.equal(isCoAuthor(FADHLY), true);
  assert.equal(isCoAuthor("BroAgentAI <359335139+broagentai[bot]@users.noreply.github.com>"), true);
  assert.equal(isCoAuthor("Fadhly Permata"), false);
  assert.equal(isCoAuthor("<a@b.co>"), false);
  assert.equal(isCoAuthor("A <not-an-email>"), false);
  assert.equal(isCoAuthor("A <a@b.co>\nEvil: x"), false);
  assert.equal(isCoAuthor(42), false);
});

test("normalizeCoAuthors drops bad entries and duplicate emails", () => {
  assert.deepEqual(normalizeCoAuthors([FADHLY, " " + FADHLY.toUpperCase().replace("FADHLY PERMATA", "Other") + " ", "bad", 7]), [FADHLY]);
  assert.deepEqual(normalizeCoAuthors("nope"), []);
});

test("trailer goes into a new paragraph after the subject or body", () => {
  assert.equal(addCoAuthorTrailers("feat: x", [FADHLY]), `feat: x\n\nCo-authored-by: ${FADHLY}`);
  assert.equal(addCoAuthorTrailers("feat: x\n\nbody text\n", [FADHLY]), `feat: x\n\nbody text\n\nCo-authored-by: ${FADHLY}`);
});

test("trailer joins an existing trailer block", () => {
  const msg = "feat: x\n\nbody\n\nRefs: #12\nSigned-off-by: A <a@b.co>";
  assert.equal(addCoAuthorTrailers(msg, [FADHLY]), `${msg}\nCo-authored-by: ${FADHLY}`);
});

test("a co-author the message already credits is not added twice", () => {
  const msg = `feat: x\n\nCo-authored-by: F P <8925077+FADHLY-permata@users.noreply.github.com>`;
  assert.equal(addCoAuthorTrailers(msg, [FADHLY]), msg);
  assert.equal(addCoAuthorTrailers("feat: x", []), "feat: x");
});

test("commitCoAuthors puts the built-in co-authors first", () => {
  const extra = "Someone Else <1+someone@users.noreply.github.com>";
  assert.deepEqual(commitCoAuthors([extra]), [...BUILT_IN_CO_AUTHORS, extra]);
  assert.ok(BUILT_IN_CO_AUTHORS.every(isCoAuthor));
});
