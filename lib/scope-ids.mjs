const IS_ID = /\b(IS-\d{3})\b/g;
const OS_LINE = /^.*\b(OS-\d{3})\b[^\n]*$/gm;

export function parseScopeIds(torText) {
  const text = String(torText ?? "");
  return {
    inScope: [...new Set([...text.matchAll(IS_ID)].map((match) => match[1]))],
    outScope: [...new Set([...text.matchAll(OS_LINE)].map((match) => match[1]))],
  };
}

export function citesUnknownIs(text, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const cited = [...String(text ?? "").matchAll(IS_ID)].map((match) => match[1]);
  return [...new Set(cited.filter((id) => !known.has(id)))];
}

export function reintroducesOs(torText, document) {
  const body = String(document ?? "");
  const found = [];
  for (const match of String(torText ?? "").matchAll(OS_LINE)) {
    const id = match[1];
    const phrase = match[0].replace(id, "").replace(/^[\s\-*:]+|[\s\-*:]+$/g, "").trim();
    if (body.includes(id) || (phrase.length > 8 && body.toLowerCase().includes(phrase.toLowerCase()))) {
      found.push(id);
    }
  }
  return [...new Set(found)];
}
