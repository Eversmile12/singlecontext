import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeShareToken, encodeShareToken, extractToken } from "../cli/share.js";

describe("share token", () => {
  it("encodes and decodes token payload", () => {
    const rawKey = Buffer.from("a".repeat(64), "hex").toString("base64url");
    const token = encodeShareToken({
      v: 1,
      sid: "share-123",
      k: rawKey,
      t: "tx-abc",
    });

    const decoded = decodeShareToken(token);
    assert.equal(decoded.shareId, "share-123");
    assert.equal(decoded.key.length, 32);
    assert.equal(decoded.txId, "tx-abc");
  });

  it("decodes legacy token without tx id", () => {
    const rawKey = Buffer.from("b".repeat(64), "hex").toString("base64url");
    const legacyToken = Buffer.from(
      JSON.stringify({ v: 1, sid: "legacy-share", k: rawKey }),
      "utf-8"
    ).toString("base64url");

    const decoded = decodeShareToken(legacyToken);
    assert.equal(decoded.shareId, "legacy-share");
    assert.equal(decoded.key.length, 32);
    assert.equal(decoded.txId, undefined);
  });

  it("extracts token from sharme URL", () => {
    const token = "abc123";
    const input = `sharme://share/${token}`;
    assert.equal(extractToken(input), token);
  });

  it("extracts token from query parameter URL", () => {
    const token = "xyz789";
    const input = `https://example.com/sync?token=${token}`;
    assert.equal(extractToken(input), token);
  });
});
