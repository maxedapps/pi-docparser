import { constants as fsConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import { IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, SPREADSHEET_EXTENSIONS } from "./constants.ts";
import type { InputCategory, InputInspection, ScreenshotSelection } from "./types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeDocumentPathInput(input: string): string {
  return input.trim().replace(/^@/, "").replace(UNICODE_SPACES, " ");
}

function expandHomeDirectory(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath;
}

function tryMacOsAmPmVariant(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPath(filePath: string, cwd: string): Promise<string> {
  const expanded = expandHomeDirectory(filePath);
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  const nfdVariant = tryNfdVariant(resolved);

  for (const candidate of new Set([
    resolved,
    tryMacOsAmPmVariant(resolved),
    nfdVariant,
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(nfdVariant),
  ])) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return resolved;
}

async function ensureReadableFile(filePath: string, sourcePath: string): Promise<void> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`Document file not found or not readable: ${sourcePath}`);
  }
}

function getInputCategory(extension: string): InputCategory | undefined {
  if (extension === ".pdf") {
    return "pdf";
  }

  if (OFFICE_EXTENSIONS.has(extension)) {
    return "office";
  }

  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return "spreadsheet";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  return undefined;
}

async function readFileHeader(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isPdfHeader(header: Buffer): boolean {
  return header.length >= 4 && header.toString("utf8", 0, 4) === "%PDF";
}

function isPngHeader(header: Buffer): boolean {
  return (
    header.length >= 4 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  );
}

function isJpegHeader(header: Buffer): boolean {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

async function inspectInputFile(filePath: string): Promise<InputInspection> {
  const extension = extname(filePath).toLowerCase();
  const category = getInputCategory(extension);

  if (category) {
    return { extension, category };
  }

  try {
    const header = await readFileHeader(filePath, 16);

    if (isPdfHeader(header)) {
      return { extension: extension || ".pdf", category: "pdf" };
    }

    if (!extension && isPngHeader(header)) {
      return { extension: ".png", category: "image" };
    }

    if (!extension && isJpegHeader(header)) {
      return { extension: ".jpg", category: "image" };
    }
  } catch {
    // Best-effort inspection only. Readability is validated separately.
  }

  return { extension, category: "other" };
}

export async function resolveDocumentTarget(
  input: string,
  cwd: string,
): Promise<{
  sourcePath: string;
  resolvedPath: string;
  inspection: InputInspection;
}> {
  const sourcePath = normalizeDocumentPathInput(input);
  const resolvedPath = await resolveExistingPath(sourcePath, cwd);

  await ensureReadableFile(resolvedPath, sourcePath);

  return {
    sourcePath,
    resolvedPath,
    inspection: await inspectInputFile(resolvedPath),
  };
}

export function parsePageSelection(selection: string): number[] {
  const pages = new Set<number>();

  for (const rawPart of selection.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    if (part.includes("-")) {
      const [rawStart, rawEnd] = part.split("-", 2).map((value) => value.trim());
      const start = Number.parseInt(rawStart, 10);
      const end = Number.parseInt(rawEnd, 10);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: ${part}`);
      }

      for (let page = start; page <= end; page++) {
        pages.add(page);
      }
      continue;
    }

    const page = Number.parseInt(part, 10);
    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`Invalid page number: ${part}`);
    }
    pages.add(page);
  }

  const result = Array.from(pages).sort((a, b) => a - b);
  if (result.length === 0) {
    throw new Error("No valid page numbers were provided.");
  }

  return result;
}

export function resolveScreenshotSelection(selection: string): ScreenshotSelection {
  const trimmedSelection = selection.trim();
  if (!trimmedSelection) {
    throw new Error("Screenshot page selection must not be empty.");
  }

  if (["all", "*"].includes(trimmedSelection.toLowerCase())) {
    return {
      pageNumbers: undefined,
      description: "all pages",
    };
  }

  return {
    pageNumbers: parsePageSelection(trimmedSelection),
    description: `pages ${trimmedSelection}`,
  };
}
