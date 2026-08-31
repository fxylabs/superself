// The package's whole surface. Two layers, and the seam between them is the
// point of the split: `foldEvents` is what an event log alone decides, and
// `applyLocalOverlay` is what one machine adds to it. A reader that has no
// clock, no session and no local git — the Workspace API server — calls the
// first and stops.

export { FOLD_VERSION } from "./version.js";
export { FoldError } from "./errors.js";

export * from "./types.js";
export * from "./dates.js";
export * from "./text.js";
export * from "./revisions.js";
export * from "./objectives.js";
export * from "./entities.js";
export * from "./completion.js";
export * from "./model.js";
export * from "./overlay.js";
