import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerDoctorCommand } from "./doctor.ts";
import { initI18n } from "./i18n.ts";
import { registerDocumentParseTool } from "./tool.ts";

export default function parseDocumentExtension(pi: ExtensionAPI) {
  initI18n(pi);
  registerDocumentParseTool(pi);
  registerDoctorCommand(pi);
}
