import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

const root = process.cwd();
const workflowDirectory = resolve(root, ".github", "workflows");
const actionReferencePattern = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function collectActionReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectActionReferences(entry, output);
    }
    return output;
  }
  if (value === null || typeof value !== "object") {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "uses" && typeof entry === "string") {
      output.push(entry);
    }
    collectActionReferences(entry, output);
  }
  return output;
}

function collectRunScripts(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRunScripts(entry, output);
    }
    return output;
  }
  if (value === null || typeof value !== "object") {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "run" && typeof entry === "string") {
      output.push(entry);
    }
    collectRunScripts(entry, output);
  }
  return output;
}

async function parseYaml(path) {
  const document = parseDocument(await readFile(path, "utf8"), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${path} is invalid YAML:\n${document.errors.map(String).join("\n")}`,
    );
  }
  return document.toJS();
}

const entries = (await readdir(workflowDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort();

assert(entries.length > 0, "No GitHub Actions workflows were found");

for (const name of entries) {
  const path = resolve(workflowDirectory, name);
  const workflow = await parseYaml(path);
  assert(workflow && typeof workflow === "object", `${name} must be a mapping`);
  assert(workflow.on !== undefined, `${name} must declare triggers`);
  assert(workflow.permissions !== undefined, `${name} must declare permissions`);
  assert(
    workflow.jobs && Object.keys(workflow.jobs).length > 0,
    `${name} must declare at least one job`,
  );
  assert(
    workflow.on.pull_request_target === undefined,
    `${name} must not use the privileged pull_request_target trigger`,
  );

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert(
      job && typeof job === "object" && job["timeout-minutes"] !== undefined,
      `${name}:${jobName} must set timeout-minutes`,
    );
  }

  for (const reference of collectActionReferences(workflow)) {
    if (reference.startsWith("./") || reference.startsWith("docker://")) {
      continue;
    }
    assert(
      actionReferencePattern.test(reference),
      `${name} uses a mutable or invalid action reference: ${reference}`,
    );
  }

  for (const script of collectRunScripts(workflow)) {
    assert(
      !script.includes("${{ secrets."),
      `${name} interpolates a secret directly into a run script; pass it via env`,
    );
  }
}

const dependabot = await parseYaml(resolve(root, ".github", "dependabot.yml"));
assert(dependabot.version === 2, "dependabot.yml must use schema version 2");
assert(
  Array.isArray(dependabot.updates) && dependabot.updates.length >= 3,
  "dependabot.yml must cover npm, GitHub Actions, and Docker",
);

console.log(
  `Validated ${entries.length} pinned GitHub Actions workflows and Dependabot configuration.`,
);
