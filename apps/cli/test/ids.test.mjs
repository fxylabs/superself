import { test } from "node:test";
import assert from "node:assert/strict";
import { isEventId, ulid, workId } from "../dist/ids.js";

test("a minted ulid is recognised as an event id", () =>
{
    const id = ulid();
    assert.equal(id.length, 26);
    assert.equal(isEventId(id), true);
});

test("isEventId rejects the wrong length and alphabet", () =>
{
    assert.equal(isEventId("w-abcde"), false);
    assert.equal(isEventId("01kz0dkcw8ekmncyyfq4h7zs5"), false);
    assert.equal(isEventId("Ax".repeat(13)), false);
});

test("isEventId rejects a timestamp outside the plausible window", () =>
{
    const rand = "0123456789abcdef";
    assert.equal(isEventId("0000000000" + rand), false);
    assert.equal(isEventId("zzzzzzzzzz" + rand), false);
});

test("a short id carries its type prefix", () =>
{
    assert.match(workId(), /^w-[0-9abcdefghjkmnpqrstvwxyz]{5}$/);
});
