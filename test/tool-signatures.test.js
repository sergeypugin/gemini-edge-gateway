import test from "node:test";
import assert from "node:assert/strict";
import { addMissingToolSignatures } from "../src/lib/tool-signatures.js";

const call = (text) => ({
  id: "call_1", type: "function", function: {
    name: "edit_file", arguments: JSON.stringify({ text })
  }
});

for (const text of ["ordinary text", "}], trailing text", 'quotes: " and \\ and ]', '[{"nested": [1, 2]}]']) {
  test(`signature survives arguments ${JSON.stringify(text)}`, () => {
    const input = { messages: [{ role: "assistant", tool_calls: [call(text)] }] };
    const result = JSON.parse(addMissingToolSignatures(JSON.stringify(input)));
    assert.equal(result.messages[0].tool_calls[0].extra_content.google.thought_signature,
      "skip_thought_signature_validator");
    assert.equal(result.messages[0].tool_calls[0].function.arguments, call(text).function.arguments);
  });
}

test("preserves real signatures and other metadata across parallel calls", () => {
  const signed = {
    ...call("first"), extra_content: {
      other: 1, google: {
        thought_signature: "real-signature", other: 2
      }
    }
  };
  const input = { messages: [{ tool_calls: [signed, call("second")] }, { tool_calls: [call("third")] }] };
  const result = JSON.parse(addMissingToolSignatures(JSON.stringify(input)));
  assert.deepEqual(result.messages[0].tool_calls[0], signed);
  assert.equal(result.messages[0].tool_calls[1].extra_content.google.thought_signature,
    "skip_thought_signature_validator");
  assert.equal(result.messages[1].tool_calls[0].extra_content.google.thought_signature,
    "skip_thought_signature_validator");
});

test("does not modify tool declarations, embedded JSON strings or image data", () => {
  const input = JSON.stringify({
    tools: [{ type: "function", function: { name: "edit_file" } }],
    messages: [{ content: JSON.stringify({ tool_calls: [call("embedded")] }) },
    { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]
  });
  assert.equal(addMissingToolSignatures(input), input);
});

test("rejects broken arrays rather than silently dropping signature repair", () => {
  assert.throws(() => addMissingToolSignatures('{"tool_calls":[{"type":"function"}'), SyntaxError);
});
