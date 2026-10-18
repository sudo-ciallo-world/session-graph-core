# Human-Controlled Task Graph Core

Preserve a person's chosen task hierarchy while applying automated semantic updates.

This is a runnable core snapshot from a larger AI-conversation browser extension. It includes graph normalization, semantic patch application, manual overrides, reorganization protection, and storage encoding. The extension UI, conversation capture, model adapters, and desktop integrations are outside this release.

## Run

Node.js 24 or later; no packages, browser, account, or model key required.

```sh
node demo.mjs
node --test --test-isolation=none test-manual-structure.mjs
```

The synthetic demo moves a task, serializes and reloads the graph, then applies an automated update. The chosen parent and sibling position remain unchanged while new evidence can update an unlocked field.

## Engineering Focus

- SOURCE / AUTO / USER separation and effective field values.
- User-selected parent and sibling order survive semantic updates and reorganization.
- Protected nodes reject structural merges and splits atomically.
- A later explicit user action can revise an earlier override.

Four focused regression tests passed on the prepared snapshot. They establish core behavior, not full extension behavior. Chrome storage helpers are present but are not invoked by the demo.

## Provenance And AI Assistance

sudo-ciallo-world conceived and led the larger application: product concept, requirements, task/state model, architecture direction, integration, debugging, validation, and acceptance criteria. Implementation and tests were developed with substantial AI-assisted coding; this repository does not claim that every line was handwritten.

No pretrained model, browser platform, or external task-execution service is presented as original work. This snapshot uses platform APIs and Node built-ins without bundled third-party JavaScript libraries.

See `SOURCE_MAP.md` for extraction boundaries and `LICENSE` for the MIT license covering sudo-ciallo-world's licensable code.

