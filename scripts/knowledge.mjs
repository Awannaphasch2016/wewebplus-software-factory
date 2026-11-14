import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const knowledgeRoot = resolve(repoRoot, "knowledge");
export const manifestPath = resolve(knowledgeRoot, "manifest.json");
export const sandboxKnowledgeRoot = resolve(
  repoRoot,
  "agents/specification/agent/sandbox/workspace/knowledge",
);

const PRECEDENCE = [
  "frozen-project-tor",
  "approved-project-decisions",
  "approved-reusable-guidelines",
  "model-suggestions",
];

const USAGES = new Set([
  "tor-structure",
  "srs-structure",
  "quality",
  "traceability",
  "precedence",
  "plan-structure",
]);

const EXPECTED_PDF_SHA256 = {
  "tor-reference":
    "456998f0cf45c88b8cc772ba9b03b7bb22c33a80be15c7ba5a820e50ac42e4af",
  "srs-reference":
    "f2bf7987098dc74ebf765e6c5838ea63d117e8a17e558a6a2daa97a8d22a5105",
};

const BANNED_GUIDELINE =
  /task-tracker|task tracker|eve-forman|harness-level/i;

export function fail(message) {
  throw new Error(`Knowledge verification failed: ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value)) &&
    value === new Date(value).toISOString()
  );
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

export function assertFailClosedAllowlists(agent) {
  if (!Array.isArray(agent?.allowedChannelIds) || agent.allowedChannelIds.length === 0) {
    fail("approved corpora require a non-empty allowedChannelIds list. An empty list means nobody.");
  }
  if (!Array.isArray(agent?.allowedUserIds) || agent.allowedUserIds.length === 0) {
    fail("approved corpora require a non-empty allowedUserIds list. An empty list means nobody.");
  }
}

function validateSlackIds(values, pattern, label) {
  if (!Array.isArray(values) || values.some((value) => !pattern.test(value))) {
    fail(`${label} must be an array of valid Slack IDs.`);
  }
  if (hasDuplicates(values)) fail(`${label} contains duplicate IDs.`);
}

function resolveWithin(root, path, label) {
  const resolved = resolve(repoRoot, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    fail(`${label} escapes its allowed directory: ${path}`);
  }
  return resolved;
}

async function requireRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${label} must be a regular file.`);
  }
}

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`knowledge cannot contain symlinks: ${displayPath(path)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const APPROVAL_REQUIRED = /^<!--\s*approval:\s*required\s*-->/i;

async function classifyGuidelines() {
  const paths = (await filesUnder(resolve(knowledgeRoot, "guidelines"))).filter(
    (path) =>
      path.endsWith(".md") &&
      !path.endsWith(`${sep}README.md`) &&
      !path.endsWith(`${sep}tor-contract-fields.md`),
  );
  const approved = [];
  const pending = [];
  for (const path of paths) {
    const contents = await readFile(path, "utf8");
    if (APPROVAL_REQUIRED.test(contents)) pending.push(path);
    else approved.push(path);
  }
  return { approved, pending };
}

export async function guidelineFiles() {
  return (await classifyGuidelines()).approved;
}

export async function pendingGuidelineFiles() {
  return (await classifyGuidelines()).pending;
}

export async function readManifest() {
  let contents;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail("manifest.json does not exist.");
    fail("manifest.json could not be read.");
  }
  try {
    return JSON.parse(contents);
  } catch {
    fail("manifest.json must contain valid JSON.");
  }
}

function sameList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

async function verifyProvenance(source) {
  const snapshot = resolve(repoRoot, source.snapshotPath);
  const provenancePath = resolve(dirname(snapshot), "provenance.json");
  await requireRegularFile(provenancePath, `provenance for ${source.id}`);
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch {
    fail(`provenance for ${source.id} must be JSON.`);
  }
  for (const field of [
    "originalFilename",
    "originalSha256",
    "extractionTool",
    "extractionToolVersion",
    "extractedAt",
    "extractedAtTimezone",
    "notes",
  ]) {
    if (!isNonEmptyString(provenance[field])) {
      fail(`provenance for ${source.id} is missing ${field}.`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.originalSha256)) {
    fail(`provenance for ${source.id} originalSha256 must be 64 lowercase hex characters.`);
  }
  if (source.usage === "plan-structure") {
    if (provenance.originalFilename !== "project-plan-template.md") {
      fail(`provenance for ${source.id} must name project-plan-template.md.`);
    }
    const hash = createHash("sha256").update(await readFile(snapshot)).digest("hex");
    if (provenance.originalSha256 !== hash) {
      fail(`provenance for ${source.id} sha256 does not match the markdown snapshot.`);
    }
    if (!/text only/i.test(provenance.notes)) {
      fail(`provenance for ${source.id} must state that only text is stored.`);
    }
    return provenancePath;
  }
  if (provenance.originalFilename.toLowerCase().endsWith(".pdf") === false) {
    fail(`provenance for ${source.id} must name the original PDF.`);
  }
  const expected = EXPECTED_PDF_SHA256[source.id];
  if (expected && provenance.originalSha256 !== expected) {
    fail(
      `provenance for ${source.id} sha256 ${provenance.originalSha256} differs from the planning-session value ${expected}.`,
    );
  }
  if (!/text only/i.test(provenance.notes)) {
    fail(`provenance for ${source.id} must state that only text is stored.`);
  }
  return provenancePath;
}

export async function verifyKnowledge() {
  const manifest = await readManifest();
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
  if (!["draft", "approved"].includes(manifest.status)) {
    fail("status must be draft or approved.");
  }

  const agent = manifest.agent;
  if (!agent || !isNonEmptyString(agent.name) || !isNonEmptyString(agent.description)) {
    fail("agent configuration is incomplete.");
  }
  if (
    agent.knowledgeOwnerSlackId !== null &&
    !/^[UW][A-Z0-9]+$/.test(agent.knowledgeOwnerSlackId ?? "")
  ) {
    fail("knowledgeOwnerSlackId must be a Slack member ID or null.");
  }
  validateSlackIds(agent.allowedChannelIds, /^[CG][A-Z0-9]+$/, "allowedChannelIds");
  validateSlackIds(agent.allowedUserIds, /^[UW][A-Z0-9]+$/, "allowedUserIds");

  if (!manifest.approval || !Array.isArray(manifest.sources) || !manifest.precedence) {
    fail("approval, precedence, and sources are required.");
  }
  if (!sameList(manifest.precedence.model, PRECEDENCE)) {
    fail("precedence.model must be the frozen four-step model.");
  }

  const sourceIds = [];
  const sourceById = new Map();
  const sourcesRoot = resolve(knowledgeRoot, "sources");
  const provenancePaths = [];
  for (const source of manifest.sources) {
    if (
      !source ||
      !/^[a-z0-9][a-z0-9-]*$/.test(source.id) ||
      !isNonEmptyString(source.title) ||
      !isNonEmptyString(source.origin) ||
      !isNonEmptyString(source.snapshotPath) ||
      !isNonEmptyString(source.owner) ||
      !Number.isInteger(source.priority) ||
      !["draft", "approved", "superseded"].includes(source.status) ||
      typeof source.rightsConfirmed !== "boolean" ||
      !USAGES.has(source.usage)
    ) {
      fail(`source entry ${source?.id ?? "(unknown)"} is invalid.`);
    }
    if (!isIsoDate(source.capturedAt)) {
      fail(`source ${source.id} capturedAt must use canonical ISO format.`);
    }
    if (!source.snapshotPath.startsWith(`knowledge/sources/${source.id}/`)) {
      fail(`source ${source.id} must point into knowledge/sources/${source.id}/.`);
    }
    if (source.usage === "plan-structure") {
      if (!source.snapshotPath.endsWith(".md")) {
        fail(`source ${source.id} snapshot must be the markdown template.`);
      }
    } else if (!source.snapshotPath.endsWith(".txt")) {
      fail(`source ${source.id} snapshot must be extracted text (.txt), never a PDF.`);
    }
    await requireRegularFile(
      resolveWithin(sourcesRoot, source.snapshotPath, `snapshot for ${source.id}`),
      `snapshot for ${source.id}`,
    );
    provenancePaths.push(await verifyProvenance(source));
    sourceIds.push(source.id);
    sourceById.set(source.id, source);
  }
  if (hasDuplicates(sourceIds)) fail("source IDs must be unique.");

  const allKnowledgeFiles = await filesUnder(knowledgeRoot);
  const pdfs = allKnowledgeFiles.filter((path) => path.toLowerCase().endsWith(".pdf"));
  if (pdfs.length > 0) {
    fail(`PDF binaries are not allowed in knowledge:\n${pdfs.map(displayPath).join("\n")}`);
  }

  const guidelines = await guidelineFiles();
  const pendingGuidelines = await pendingGuidelineFiles();
  for (const guideline of guidelines) {
    const contents = await readFile(guideline, "utf8");
    if (BANNED_GUIDELINE.test(contents)) {
      fail(
        `${displayPath(guideline)} contains project-specific content. Guidelines must stay reusable.`,
      );
    }
    const metadata = contents.match(
      /^<!--\s*sources:\s*([a-z0-9,\s-]+)\s*-->\r?\n<!--\s*priority:\s*(-?\d+)\s*-->/i,
    );
    const sources = metadata?.[1];
    const priority = metadata?.[2];
    if (!sources || priority === undefined) {
      fail(`${displayPath(guideline)} must start with sources and integer priority metadata.`);
    }
    const referencedSources = sources
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean);
    if (hasDuplicates(referencedSources)) {
      fail(`${displayPath(guideline)} contains duplicate source references.`);
    }
    if (
      referencedSources.length === 0 ||
      referencedSources.some((source) => !sourceIds.includes(source))
    ) {
      fail(`${displayPath(guideline)} references an unknown source.`);
    }
    const referencedEntries = referencedSources.map((source) => sourceById.get(source));
    if (
      referencedEntries.some(
        (source) =>
          source.status === "superseded" ||
          (manifest.status === "approved" && source.status !== "approved"),
      )
    ) {
      fail(`${displayPath(guideline)} references an inactive source.`);
    }
    const priorities = new Set(referencedEntries.map((source) => source.priority));
    if (priorities.size > 1) {
      fail(
        `${displayPath(guideline)} references sources with different priorities; split it into one file per priority.`,
      );
    }
    const [expectedPriority] = priorities;
    if (Number(priority) !== expectedPriority) {
      fail(`${displayPath(guideline)} priority must match its sources.`);
    }
  }

  for (const guideline of pendingGuidelines) {
    const contents = await readFile(guideline, "utf8");
    if (BANNED_GUIDELINE.test(contents)) {
      fail(`${displayPath(guideline)} contains project-specific content. Guidelines must stay reusable.`);
    }
    const body = contents.replace(/^<!--\s*approval:\s*required\s*-->\r?\n/i, "");
    const metadata = body.match(
      /^<!--\s*sources:\s*([a-z0-9,\s-]+)\s*-->\r?\n<!--\s*priority:\s*(-?\d+)\s*-->/i,
    );
    if (!metadata) {
      fail(`${displayPath(guideline)} needs approval and must still name its sources and priority.`);
    }
    const referencedSources = metadata[1]
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean);
    if (referencedSources.some((source) => !sourceIds.includes(source))) {
      fail(`${displayPath(guideline)} references an unknown source.`);
    }
  }

  const allowedFiles = new Set([
    manifestPath,
    resolve(knowledgeRoot, "manifest.schema.json"),
    resolve(knowledgeRoot, "guidelines/README.md"),
    resolve(knowledgeRoot, "guidelines/tor-contract-fields.md"),
    resolve(knowledgeRoot, "sources/README.md"),
    ...guidelines,
    ...pendingGuidelines,
    ...manifest.sources.map((source) => resolve(repoRoot, source.snapshotPath)),
    ...provenancePaths,
  ]);
  const unexpectedFiles = allKnowledgeFiles.filter((path) => !allowedFiles.has(path));
  if (unexpectedFiles.length > 0) {
    fail(
      `knowledge contains files that are not reviewed corpus entries:\n${unexpectedFiles
        .map(displayPath)
        .join("\n")}`,
    );
  }

  if (manifest.status === "approved") {
    if (!agent.knowledgeOwnerSlackId) {
      fail("approved corpora require a knowledgeOwnerSlackId.");
    }
    assertFailClosedAllowlists(agent);
    if (
      !isNonEmptyString(manifest.approval.approvedBy) ||
      !isIsoDate(manifest.approval.approvedAt)
    ) {
      fail("approved corpora require approver identity and a canonical ISO approval time.");
    }
    if (!isNonEmptyString(manifest.approval.delegation)) {
      fail("approved corpora must record the approval delegation explicitly.");
    }
    if (
      manifest.approval.approvedBy.includes("on behalf of") &&
      !/delegat/i.test(manifest.approval.delegation)
    ) {
      fail("delegated approval must say that the approval was delegated.");
    }
    if (manifest.sources.length === 0) {
      fail("approved corpora require at least one source.");
    }
    if (manifest.sources.every((source) => source.status !== "approved")) {
      fail("approved corpora require at least one active approved source.");
    }
    if (
      manifest.sources.some((source) => source.status === "draft" || !source.rightsConfirmed)
    ) {
      fail("sources cannot be draft and must be rights-confirmed.");
    }
    if (guidelines.length === 0) {
      fail("approved corpora require at least one normalized guideline file.");
    }
  } else if (
    manifest.approval.approvedBy !== null ||
    manifest.approval.approvedAt !== null
  ) {
    fail("draft corpora cannot carry approval metadata.");
  }

  return manifest;
}

export function displayPath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}
