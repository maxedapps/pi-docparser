import type { Static } from "@mariozechner/pi-ai";
import type { LiteParseConfig } from "@llamaindex/liteparse";

import { DocumentParseSchema } from "./schema.ts";

export type DocumentParseParams = Static<typeof DocumentParseSchema>;
export type DocumentOutputFormat = NonNullable<DocumentParseParams["format"]>;

export interface DocumentParseDetails {
  sourcePath: string;
  resolvedPath: string;
  outputFormat: DocumentOutputFormat;
  outputPath: string;
  outputDir: string;
  pageCount: number;
  screenshotCount: number;
  screenshotDir?: string;
  screenshotPathsPreview?: string[];
  warnings?: string[];
}

export type InputCategory = "pdf" | "office" | "spreadsheet" | "image" | "other";
export type DependencyName = "libreoffice" | "imagemagick" | "ghostscript";
export type PackageManagerId =
  | "brew"
  | "apt-get"
  | "dnf"
  | "yum"
  | "pacman"
  | "zypper"
  | "apk"
  | "winget"
  | "choco";

export interface InputInspection {
  extension: string;
  category: InputCategory;
}

export interface DependencyDiagnosis {
  name: DependencyName;
  label: string;
  installed: boolean;
  detectedCommand?: string;
  relevant: boolean;
  summary: string;
  missingMessage: string;
}

export interface InstallCommandSpec {
  description: string;
  command: string;
  args: string[];
  display: string;
  timeoutMs?: number;
}

export interface InstallStrategy {
  id: PackageManagerId;
  label: string;
  autoRunnable: boolean;
  autoRunBlockedReason?: string;
  commands: InstallCommandSpec[];
}

export interface UnixPrivilegeContext {
  prefix: string[];
  displayPrefix: string;
  autoRunnable: boolean;
  blockedReason?: string;
}

export interface ScreenshotSelection {
  pageNumbers?: number[];
  description: string;
}

export type LiteParseToolConfig = Partial<
  Pick<
    LiteParseConfig,
    | "outputFormat"
    | "ocrEnabled"
    | "ocrLanguage"
    | "ocrServerUrl"
    | "numWorkers"
    | "maxPages"
    | "targetPages"
    | "dpi"
    | "preciseBoundingBox"
    | "preserveVerySmallText"
    | "preserveLayoutAlignmentAcrossPages"
  >
>;

export interface DocumentParsePlan {
  parserConfig: LiteParseToolConfig;
  screenshotSelection?: ScreenshotSelection;
  warnings: string[];
}
