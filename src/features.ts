// The default feature set both entries (main.ts / harness-entry.ts) install.
// Each Dev DAG feature task appends its installer here; `core` ships the
// skeleton with an empty list.

import type { Feature } from "./bot.js";
import { catalogFeature } from "./handlers/catalog.js";
import { slotsFeature } from "./slots.js";

export const defaultFeatures: Feature[] = [catalogFeature, slotsFeature];
