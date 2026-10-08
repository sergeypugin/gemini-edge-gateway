function findStringEnd(text, start) {
  let end = text.indexOf('"', start + 1);
  while (end >= 0) {
    let backslashes = 0;
    for (let i = end - 1; i > start && text[i] == "\\"; i--) backslashes++;
    if (backslashes % 2 == 0) return end;
    end = text.indexOf('"', end + 1);
  }
  throw new SyntaxError("Unterminated JSON string");
}

function findArrayEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] == '"') {
      i = findStringEnd(text, i);
    } else if (text[i] == "[") {
      depth++;
    } else if (text[i] == "]" && --depth == 0) {
      return i;
    }
  }
  throw new SyntaxError("Unterminated tool calls array");
}

export function addMissingToolSignatures(text) {
  const pieces = [];
  let copiedUntil = 0;
  let start = text.indexOf('"');
  while (start >= 0) {
    const end = findStringEnd(text, start);
    if (text.slice(start, end + 1) == '"tool_calls"') {
      const suffix = /^\s*:\s*\[/.exec(text.slice(end + 1));
      if (suffix) {
        const arrayStart = end + suffix[0].length;
        const arrayEnd = findArrayEnd(text, arrayStart);
        const calls = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
        let modified = false;
        for (const call of calls) {
          if (call?.type != "function") continue;
          if (call.extra_content?.google?.thought_signature) continue;
          call.extra_content = {
            ...call.extra_content,
            google: {
              ...call.extra_content?.google,
              thought_signature: "skip_thought_signature_validator"
            }
          };
          modified = true;
        }
        if (modified) {
          pieces.push(text.slice(copiedUntil, arrayStart), JSON.stringify(calls));
          copiedUntil = arrayEnd + 1;
        }
        start = text.indexOf('"', arrayEnd + 1);
        continue;
      }
    }
    start = text.indexOf('"', end + 1);
  }
  if (pieces.length == 0) return text;
  pieces.push(text.slice(copiedUntil));
  return pieces.join("");
}
