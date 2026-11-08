// quick-agent pi extension entry point (loaded by pi as an installed package).
//
//   QA_TASK_ID set  → worker role: owns one task, reports to the hub.
//   otherwise       → front role in interactive (TUI) pi: quick, delegates work to workers.
//                     Non-interactive pi (-p / json / rpc) is left untouched.
//   QA_WATCH_TASK set → the hub's read-only watchdog reviewer (hub/watchdog.ts): no quick-agent role at all,
//                     even if QA_TASK_ID leaked into its environment.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupFront } from "./front.ts";
import { setupWorker } from "./worker.ts";

export default function quickAgent(pi: ExtensionAPI) {
	if (process.env.QA_WATCH_TASK) return;
	const taskId = process.env.QA_TASK_ID;
	if (taskId) setupWorker(pi, taskId);
	else setupFront(pi);
}
