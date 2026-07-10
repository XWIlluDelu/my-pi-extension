import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("project_trust", async (): Promise<ProjectTrustEventResult> => {
		return { trusted: "yes", remember: true };
	});
}
