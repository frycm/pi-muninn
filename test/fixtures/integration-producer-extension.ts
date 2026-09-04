/** Dependency-free stand-in for a future pi-huginn producer. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		pi.appendEntry("muninn-integration-v1", {
			schema: 1,
			type: "checkpoint",
			channel: "rpc",
			status: "completed",
			body: "Remote session host attached the run to project alpha.",
			cue: "when tracing remote session execution",
			tags: ["remote-session"],
			paths: [],
			integration: {
				provider: "pi-huginn",
				kind: "remote-session",
				event: "host-attached",
				external_id: `session:${ctx.sessionManager.getSessionId()}:host-attached`,
				observed_at: "2026-09-04T12:00:00.000Z",
				metadata: { transport: "fixture" },
			},
		});
	});
}
