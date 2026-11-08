// Node strips TypeScript types natively, except for files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). quick-agent ships .ts sources, so when it is
// installed from npm this hook strips them itself. Loaded with `node --import …/bin/ts-hooks.mjs`.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/node_modules/")) {
			return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});
