// The process a finished command leaves behind to send its queue.
//
// A file of its own, holding one call, because it is an entry point: the parent
// resolves it by name off this module's own URL, and a name that resolved to a
// module with other callers would be a module that could not be started
// directly. It takes the store directory as its one argument, since a detached
// process inherits no working directory it can be trusted to resolve from.
//
// It says nothing and answers nothing. Whatever it learns it writes into the
// queue, and the next command with a terminal in front of it does the talking.
import { pushStore } from "./pusher.js";

await pushStore(process.argv[2] ?? "");
