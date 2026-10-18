# Session Graph Core

Keep a manually arranged task graph stable while automated updates add new information.

Moving a task should be a lasting choice. This JavaScript core separates source data, automated fields, and user overrides so a later semantic update can refresh a summary without undoing the chosen parent or sibling order.

This repository contains the graph engine extracted from a larger conversation browser extension. You can run its demo and regression tests directly with Node.js.

## Quick start

Requires **Node.js 24 or later**. There are no package dependencies.

```sh
git clone https://github.com/sudo-ciallo-world/session-graph-core.git
cd session-graph-core
node demo.mjs
```

The demo uses a synthetic graph. It moves a task to a chosen branch, saves and reloads it, then applies both a semantic patch and a reorganization.

Expected output:

```json
{
  "fixture": "SYNTHETIC ONLY",
  "manualParent": "chosen",
  "manualOrder": 0,
  "refreshedSummary": "Synthetic new evidence",
  "manualStructurePreserved": true
}
```

No browser, account, network request, or model key is needed.

## How updates work

Each node keeps separate source, automatic, and user layers. Read the effective values through the exported helpers rather than reading the automatic layer alone.

- A manual move records the chosen parent and sibling position.
- Automated patches can update fields that have no user override.
- Reorganization rejects merges or splits that would change protected structure.
- A later explicit user action can revise the earlier choice.

The demo's central operation is:

```js
import {
  normalizeGraph,
  reparentUserNode,
  applySemanticPatch,
  effectiveParentId,
} from "./graph-core.js";
import fixture from "./fixtures/task-graph.json" with { type: "json" };

let graph = normalizeGraph(structuredClone(fixture));
graph = reparentUserNode(graph, "task", "chosen", 0);
graph = applySemanticPatch(graph, {
  update_nodes: [{ id: "task", parent_id: "original", summary: "New evidence" }],
}).graph;

console.log(effectiveParentId(graph.nodes.task)); // chosen
```

See [demo.mjs](demo.mjs) for the complete reload and reorganization example.

## Tests

```sh
node --test --test-isolation=none test-manual-structure.mjs
```

The four regression tests cover:

- Parent and sibling order after reload, semantic updates, and reorganization.
- Atomic rejection of merges and splits involving protected nodes or parents.
- Unlocked children following a merged parent while a manually moved child stays put.
- A new user move replacing an earlier structural override.

## Code map

| File | Responsibility |
| --- | --- |
| [graph-core.js](graph-core.js) | Normalization, effective values, user moves, and semantic patches |
| [priority-core.js](priority-core.js) | Reorganization and structural protection |
| [reorganization-safety.js](reorganization-safety.js) | Rejecting results computed against stale graph or user state |
| [task-routing-core.js](task-routing-core.js) | Task routing helpers |
| [graph-storage.js](graph-storage.js) / [graph-compression.js](graph-compression.js) | Storage encoding and compression |
| [test-manual-structure.mjs](test-manual-structure.mjs) | Structural regression cases |

## Scope and limitations

The browser extension UI, conversation capture, model adapters, and desktop integrations are outside this release. Chrome storage helpers are included, but the offline demo does not invoke them. The tests establish graph behavior; browser storage and the complete extension need their own integration checks.

All shipped fixtures are synthetic. No conversation history, private configuration, or captured user data is included.

## Contributing

For a bug report, include a small synthetic graph, the patch or move applied to it, and the expected effective parent and order. For a fix, add a focused case to [test-manual-structure.mjs](test-manual-structure.mjs) and run the command above.

## Development and license

The project maintainer led the concept, requirements, architecture, integration, debugging, and validation. Implementation and tests used substantial AI-assisted coding.

Most development took place locally before the first public snapshot on **October 18, 2026**. Public commits record released snapshots and subsequent changes.

Released under the [MIT license](LICENSE). [SOURCE_MAP.md](SOURCE_MAP.md) describes the extraction boundaries; [LICENSE-DECISION.md](LICENSE-DECISION.md) records the contribution and licensing scope.
