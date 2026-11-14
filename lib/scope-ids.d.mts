export function parseScopeIds(torText: string): { inScope: string[]; outScope: string[] };
export function citesUnknownIs(text: string, knownIds: Iterable<string> | Set<string>): string[];
export function reintroducesOs(torText: string, document: string): string[];
