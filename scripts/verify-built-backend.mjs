const runtimeModules = [
  "../packages/database/dist/index.js",
  "../apps/api/dist/services/repository-import.service.js",
  "../apps/worker/dist/persistence/indexing-persistence.js",
  "../apps/worker/dist/services/github-webhook-repository.service.js",
];

for (const runtimeModule of runtimeModules) {
  await import(new URL(runtimeModule, import.meta.url));
}

console.log(`Verified ${runtimeModules.length} compiled backend runtime modules.`);
