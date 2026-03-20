import { truncateTail } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import {
  DOCTOR_COMMAND,
  GHOSTSCRIPT_REQUIRED_EXTENSIONS,
  INSTALL_COMMAND_TIMEOUT_MS,
} from "./constants.ts";
import type {
  DependencyDiagnosis,
  DependencyName,
  InputCategory,
  InputInspection,
  InstallCommandSpec,
  InstallStrategy,
  PackageManagerId,
  UnixPrivilegeContext,
} from "./types.ts";

const DEPENDENCY_NAMES = ["libreoffice", "imagemagick", "ghostscript"] as const;
const PLATFORM_LABELS = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
} as const;
const INPUT_CATEGORY_LABELS: Record<InputCategory, string> = {
  pdf: "PDF",
  office: "Office document",
  spreadsheet: "Spreadsheet / tabular document",
  image: "Image",
  other: "Other / unknown",
};
const PACKAGE_NAMES: Record<PackageManagerId, Record<DependencyName, string>> = {
  brew: {
    libreoffice: "libreoffice",
    imagemagick: "imagemagick",
    ghostscript: "ghostscript",
  },
  "apt-get": {
    libreoffice: "libreoffice",
    imagemagick: "imagemagick",
    ghostscript: "ghostscript",
  },
  dnf: {
    libreoffice: "libreoffice",
    imagemagick: "ImageMagick",
    ghostscript: "ghostscript",
  },
  yum: {
    libreoffice: "libreoffice",
    imagemagick: "ImageMagick",
    ghostscript: "ghostscript",
  },
  pacman: {
    libreoffice: "libreoffice-fresh",
    imagemagick: "imagemagick",
    ghostscript: "ghostscript",
  },
  zypper: {
    libreoffice: "libreoffice",
    imagemagick: "ImageMagick",
    ghostscript: "ghostscript",
  },
  apk: {
    libreoffice: "libreoffice",
    imagemagick: "imagemagick",
    ghostscript: "ghostscript",
  },
  winget: {
    libreoffice: "TheDocumentFoundation.LibreOffice",
    imagemagick: "ImageMagick.Q16",
    ghostscript: "ArtifexSoftware.GhostScript",
  },
  choco: {
    libreoffice: "libreoffice-fresh",
    imagemagick: "imagemagick.app",
    ghostscript: "ghostscript",
  },
};
const BREW_CASK_DEPENDENCIES = new Set<DependencyName>(["libreoffice"]);
const LINUX_MANAGERS: Array<{ id: PackageManagerId; label: string }> = [
  { id: "apt-get", label: "APT" },
  { id: "dnf", label: "DNF" },
  { id: "yum", label: "YUM" },
  { id: "pacman", label: "pacman" },
  { id: "zypper", label: "zypper" },
  { id: "apk", label: "apk" },
];
const DEPENDENCY_SETUP_PATTERNS = [
  "LibreOffice is not installed",
  "ImageMagick is not installed",
  "Ghostscript is required",
];

async function spawnSucceeded(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function runBinaryLookup(binary: string): Promise<boolean> {
  return spawnSucceeded(process.platform === "win32" ? "where" : "which", [binary]);
}

async function isExecutablePathAvailable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFirstAvailableCommand(
  commandNames: string[],
  candidatePaths: string[] = [],
): Promise<string | undefined> {
  for (const commandName of commandNames) {
    if (await runBinaryLookup(commandName)) {
      return commandName;
    }
  }

  for (const candidatePath of candidatePaths) {
    if (await isExecutablePathAvailable(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

function getPackageNames(manager: PackageManagerId, dependencyNames: DependencyName[]): string[] {
  return dependencyNames.map((dependencyName) => PACKAGE_NAMES[manager][dependencyName]);
}

function buildCommandDisplay(command: string, args: string[], displayPrefix = ""): string {
  return `${displayPrefix}${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

function createCommandSpec(
  description: string,
  command: string,
  args: string[],
  options: { prefix?: string[]; displayPrefix?: string; timeoutMs?: number } = {},
): InstallCommandSpec {
  const prefix = options.prefix ?? [];
  const displayPrefix = options.displayPrefix ?? "";

  if (prefix.length === 0) {
    return {
      description,
      command,
      args,
      display: buildCommandDisplay(command, args),
      timeoutMs: options.timeoutMs,
    };
  }

  return {
    description,
    command: prefix[0],
    args: [...prefix.slice(1), command, ...args],
    display: buildCommandDisplay(command, args, displayPrefix),
    timeoutMs: options.timeoutMs,
  };
}

function createDisplayCommand(manager: PackageManagerId, dependencyName: DependencyName): string {
  if (manager === "brew" && BREW_CASK_DEPENDENCIES.has(dependencyName)) {
    return buildCommandDisplay("brew", ["install", "--cask", PACKAGE_NAMES.brew[dependencyName]]);
  }

  if (manager === "choco") {
    return buildCommandDisplay("choco", ["install", PACKAGE_NAMES.choco[dependencyName]]);
  }

  return buildCommandDisplay(manager, ["install", PACKAGE_NAMES[manager][dependencyName]]);
}

function buildGuidedInstallMessage(
  dependencyName: DependencyName,
  summary: string,
  options: { requiredForFileType?: string } = {},
): string {
  const macCommand = createDisplayCommand("brew", dependencyName);
  const ubuntuCommand = createDisplayCommand("apt-get", dependencyName);
  const windowsCommand = createDisplayCommand("choco", dependencyName);
  const requirement = options.requiredForFileType
    ? ` to convert ${options.requiredForFileType} files`
    : "";

  return `${summary}${requirement}. On macOS: ${macCommand}, On Ubuntu: ${ubuntuCommand}, On Windows: ${windowsCommand}`;
}

function formatGhostscriptMissingMessage(extension: string): string {
  const fileTypeLabel = (extension || "vector").replace(/^\./, "").toUpperCase();
  return buildGuidedInstallMessage("ghostscript", `Ghostscript is required but is not installed`, {
    requiredForFileType: fileTypeLabel,
  });
}

function getLinuxInstallArgs(managerId: PackageManagerId, packageNames: string[]): string[] {
  if (managerId === "pacman") {
    return ["-Sy", "--noconfirm", ...packageNames];
  }

  if (managerId === "apk") {
    return ["add", ...packageNames];
  }

  return ["install", "-y", ...packageNames];
}

async function getUnixPrivilegeContext(): Promise<UnixPrivilegeContext> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return {
      prefix: [],
      displayPrefix: "",
      autoRunnable: true,
    };
  }

  if ((await runBinaryLookup("sudo")) && (await spawnSucceeded("sudo", ["-n", "true"]))) {
    return {
      prefix: ["sudo", "-n"],
      displayPrefix: "sudo ",
      autoRunnable: true,
    };
  }

  return {
    prefix: ["sudo", "-n"],
    displayPrefix: "sudo ",
    autoRunnable: false,
    blockedReason: "Automatic install on Linux requires root privileges or passwordless sudo.",
  };
}

function buildLinuxInstallCommands(
  manager: { id: PackageManagerId; label: string },
  dependencyNames: DependencyName[],
  privilegeContext: UnixPrivilegeContext,
): InstallCommandSpec[] {
  const packageNames = getPackageNames(manager.id, dependencyNames);
  const commands: InstallCommandSpec[] = [];

  if (manager.id === "apt-get") {
    commands.push(
      createCommandSpec("Refresh apt package metadata", "apt-get", ["update"], {
        prefix: privilegeContext.prefix,
        displayPrefix: privilegeContext.displayPrefix,
        timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
      }),
    );
  }

  commands.push(
    createCommandSpec(
      `Install missing document parser dependencies via ${manager.label}`,
      manager.id,
      getLinuxInstallArgs(manager.id, packageNames),
      {
        prefix: privilegeContext.prefix,
        displayPrefix: privilegeContext.displayPrefix,
        timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
      },
    ),
  );

  return commands;
}

function buildBrewInstallCommands(dependencyNames: DependencyName[]): InstallCommandSpec[] {
  const formulaDependencies = dependencyNames.filter(
    (dependencyName) => !BREW_CASK_DEPENDENCIES.has(dependencyName),
  );
  const caskDependencies = dependencyNames.filter((dependencyName) =>
    BREW_CASK_DEPENDENCIES.has(dependencyName),
  );
  const commands: InstallCommandSpec[] = [];

  if (formulaDependencies.length > 0) {
    commands.push(
      createCommandSpec(
        "Install missing document parser dependencies via Homebrew",
        "brew",
        ["install", ...getPackageNames("brew", formulaDependencies)],
        { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS },
      ),
    );
  }

  if (caskDependencies.length > 0) {
    commands.push(
      createCommandSpec(
        "Install missing document parser dependencies via Homebrew Cask",
        "brew",
        ["install", "--cask", ...getPackageNames("brew", caskDependencies)],
        { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS },
      ),
    );
  }

  return commands;
}

function buildWingetCommands(dependencyNames: DependencyName[]): InstallCommandSpec[] {
  return dependencyNames.map((dependencyName) =>
    createCommandSpec(
      `Install ${DEPENDENCY_METADATA[dependencyName].label} via winget`,
      "winget",
      [
        "install",
        "-e",
        "--id",
        PACKAGE_NAMES.winget[dependencyName],
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS },
    ),
  );
}

const DEPENDENCY_METADATA: Record<
  DependencyName,
  {
    label: string;
    summary: string;
    findCommand: () => Promise<string | undefined>;
    getMissingMessage: (inspection?: InputInspection) => string;
  }
> = {
  libreoffice: {
    label: "LibreOffice",
    summary:
      "Needed for Office documents and spreadsheets such as DOCX, PPTX, XLSX, CSV, and similar formats.",
    findCommand: () =>
      findFirstAvailableCommand(
        ["libreoffice", "soffice"],
        process.platform === "darwin"
          ? [
              "/Applications/LibreOffice.app/Contents/MacOS/soffice",
              "/Applications/LibreOffice.app/Contents/MacOS/libreoffice",
            ]
          : process.platform === "win32"
            ? [
                "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
                "C:\\Program Files\\LibreOffice\\program\\libreoffice.exe",
                "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
                "C:\\Program Files (x86)\\LibreOffice\\program\\libreoffice.exe",
              ]
            : [],
      ),
    getMissingMessage: () =>
      buildGuidedInstallMessage(
        "libreoffice",
        "LibreOffice is not installed. Please install LibreOffice to convert office documents",
      ),
  },
  imagemagick: {
    label: "ImageMagick",
    summary:
      "Needed for image inputs such as PNG, JPG, TIFF, WebP, SVG, and similar formats that must be converted before parsing.",
    findCommand: () =>
      findFirstAvailableCommand(process.platform === "win32" ? ["magick"] : ["magick", "convert"]),
    getMissingMessage: () =>
      buildGuidedInstallMessage(
        "imagemagick",
        "ImageMagick is not installed. Please install ImageMagick to convert images",
      ),
  },
  ghostscript: {
    label: "Ghostscript",
    summary:
      "Needed for vector image conversion paths such as SVG, EPS, PS, and AI when ImageMagick delegates rendering.",
    findCommand: () => findFirstAvailableCommand(["gs", "gswin64c", "gswin32c"]),
    getMissingMessage: (inspection) =>
      formatGhostscriptMissingMessage(inspection?.extension || ".svg"),
  },
};

export function getRelevantDependencyNames(inspection?: InputInspection): Set<DependencyName> {
  if (!inspection) {
    return new Set(DEPENDENCY_NAMES);
  }

  const relevantDependencies =
    inspection.category === "office" || inspection.category === "spreadsheet"
      ? new Set<DependencyName>(["libreoffice"])
      : inspection.category === "image"
        ? new Set<DependencyName>(["imagemagick"])
        : new Set<DependencyName>();

  if (
    inspection.category === "image" &&
    GHOSTSCRIPT_REQUIRED_EXTENSIONS.has(inspection.extension)
  ) {
    relevantDependencies.add("ghostscript");
  }

  return relevantDependencies;
}

export async function diagnoseDependencies(
  inspection?: InputInspection,
): Promise<DependencyDiagnosis[]> {
  const relevantDependencies = getRelevantDependencyNames(inspection);
  const detectedCommands = await Promise.all(
    DEPENDENCY_NAMES.map((dependencyName) => DEPENDENCY_METADATA[dependencyName].findCommand()),
  );

  return DEPENDENCY_NAMES.map((dependencyName, index) => ({
    name: dependencyName,
    label: DEPENDENCY_METADATA[dependencyName].label,
    installed: Boolean(detectedCommands[index]),
    detectedCommand: detectedCommands[index],
    relevant: relevantDependencies.has(dependencyName),
    summary: DEPENDENCY_METADATA[dependencyName].summary,
    missingMessage: DEPENDENCY_METADATA[dependencyName].getMissingMessage(inspection),
  }));
}

export async function getMissingHostDependencyMessage(
  inspection: InputInspection,
): Promise<string | undefined> {
  const diagnoses = await diagnoseDependencies(inspection);
  return diagnoses.find((diagnosis) => diagnosis.relevant && !diagnosis.installed)?.missingMessage;
}

export function isDependencySetupMessage(message: string): boolean {
  return DEPENDENCY_SETUP_PATTERNS.some((pattern) => message.includes(pattern));
}

export function appendDoctorHint(message: string): string {
  return message.includes(DOCTOR_COMMAND)
    ? message
    : `${message} Run ${DOCTOR_COMMAND} for guided setup.`;
}

export function getPlatformLabel(): string {
  return PLATFORM_LABELS[process.platform as keyof typeof PLATFORM_LABELS] ?? process.platform;
}

export function getInputCategoryLabel(category: InputCategory): string {
  return INPUT_CATEGORY_LABELS[category];
}

export async function buildInstallStrategies(
  missingDependencies: DependencyDiagnosis[],
): Promise<InstallStrategy[]> {
  const missingNames = Array.from(
    new Set(
      missingDependencies
        .filter((dependency) => !dependency.installed)
        .map((dependency) => dependency.name),
    ),
  );
  if (missingNames.length === 0) {
    return [];
  }

  if (process.platform === "darwin") {
    const brewAvailable = await runBinaryLookup("brew");

    return [
      {
        id: "brew",
        label: "Homebrew",
        autoRunnable: brewAvailable,
        autoRunBlockedReason: brewAvailable ? undefined : "Homebrew was not detected on PATH.",
        commands: buildBrewInstallCommands(missingNames),
      },
    ];
  }

  if (process.platform === "linux") {
    const privilegeContext = await getUnixPrivilegeContext();
    const strategies: InstallStrategy[] = [];

    for (const manager of LINUX_MANAGERS) {
      if (!(await runBinaryLookup(manager.id))) {
        continue;
      }

      strategies.push({
        id: manager.id,
        label: manager.label,
        autoRunnable: privilegeContext.autoRunnable,
        autoRunBlockedReason: privilegeContext.autoRunnable
          ? undefined
          : privilegeContext.blockedReason,
        commands: buildLinuxInstallCommands(manager, missingNames, privilegeContext),
      });
    }

    return strategies;
  }

  if (process.platform === "win32") {
    const wingetAvailable = await runBinaryLookup("winget");
    const chocoAvailable = await runBinaryLookup("choco");
    const strategies: InstallStrategy[] = [];

    if (wingetAvailable) {
      strategies.push({
        id: "winget",
        label: "winget",
        autoRunnable: true,
        commands: buildWingetCommands(missingNames),
      });
    }

    if (chocoAvailable) {
      strategies.push({
        id: "choco",
        label: "Chocolatey",
        autoRunnable: true,
        commands: [
          createCommandSpec(
            "Install missing document parser dependencies via Chocolatey",
            "choco",
            ["install", "-y", ...getPackageNames("choco", missingNames)],
            { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS },
          ),
        ],
      });
    }

    if (wingetAvailable || chocoAvailable) {
      return strategies;
    }

    return [
      {
        id: "winget",
        label: "winget",
        autoRunnable: false,
        autoRunBlockedReason: "Neither winget nor Chocolatey was detected on PATH.",
        commands: buildWingetCommands(missingNames),
      },
    ];
  }

  return [];
}

export function getPreferredStrategies(strategies: InstallStrategy[]): InstallStrategy[] {
  const order =
    process.platform === "darwin"
      ? ["brew"]
      : process.platform === "linux"
        ? ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"]
        : ["winget", "choco"];
  const getOrderIndex = (id: PackageManagerId) => {
    const index = order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return [...strategies].sort((a, b) => getOrderIndex(a.id) - getOrderIndex(b.id));
}

export function summarizeInstallOutput(stdout: string, stderr: string): string | undefined {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
  if (!combined) {
    return undefined;
  }

  const truncation = truncateTail(combined, {
    maxLines: 20,
    maxBytes: 2 * 1024,
  });

  return truncation.content.trim();
}
