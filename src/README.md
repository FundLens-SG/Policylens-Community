# PolicyLens Source Split Scaffold

PolicyLens still deploys as a self-contained `index.html`. That file remains the canonical runtime artifact for now.

This folder is a staging area for moving toward internal modules without losing single-file deployment simplicity.

## Current Workflow

- `npm run split:preview` lists the existing `// MODULE:` boundaries inside `index.html`.
- `node tools/extract-index-modules.mjs --write` writes generated preview fragments to `src/generated/`.
- Generated fragments are for review and migration planning only. Do not edit them as source of truth yet.

## Migration Rule

When a module is eventually made canonical, add a build step that reassembles the single-file deploy output and keep regression tests passing with `npm run test:golden`.
