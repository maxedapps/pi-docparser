import { cpus } from "node:os";

export const PREVIEW_MAX_LINES = 20;
export const PREVIEW_MAX_BYTES = 2 * 1024;
export const DEFAULT_MAX_PAGES = 10000;
export const DEFAULT_DPI = 150;
export const DEFAULT_NUM_WORKERS = Math.max(1, cpus().length - 1);
export const INSTALL_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotm",
  ".dotx",
  ".odt",
  ".ott",
  ".ppt",
  ".pptx",
  ".pptm",
  ".pot",
  ".potm",
  ".potx",
  ".odp",
  ".otp",
  ".rtf",
  ".pages",
  ".key",
]);

export const SPREADSHEET_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".ods",
  ".ots",
  ".csv",
  ".tsv",
  ".numbers",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
  ".svg",
  ".eps",
  ".ps",
  ".ai",
]);

export const GHOSTSCRIPT_REQUIRED_EXTENSIONS = new Set([".svg", ".eps", ".ps", ".ai"]);

export const DOCTOR_COMMAND_NAME = "docparser:doctor";
export const DOCTOR_COMMAND = `/${DOCTOR_COMMAND_NAME}`;
