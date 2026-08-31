// The fold's calculation, versioned. Two readers of one log — this CLI and the
// Workspace API server — agree on the state they compute only while they fold
// the same way, and a response that names a different version is what tells a
// reader its answer and the server's were not produced by the same code.
//
// Bumped when the fold's output changes for an unchanged log. A refactor that
// moves the same calculation does not bump it; a new reducer, a changed
// lifecycle rule or a new derived field does.
export const FOLD_VERSION = 1;
