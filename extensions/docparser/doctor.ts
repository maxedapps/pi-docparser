import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { DOCTOR_COMMAND, DOCTOR_COMMAND_NAME, INSTALL_COMMAND_TIMEOUT_MS } from "./constants.ts";
import {
  buildInstallStrategies,
  diagnoseDependencies,
  getInputCategoryLabel,
  getPlatformLabel,
  getPreferredStrategies,
  getRelevantDependencyNames,
  summarizeInstallOutput,
} from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import type {
  DependencyDiagnosis,
  InputInspection,
  InstallCommandSpec,
  InstallStrategy,
} from "./types.ts";

function normalizeDoctorArgument(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const isQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));

  return isQuoted ? trimmed.slice(1, -1) : trimmed;
}

function formatDoctorReport(options: {
  inspection?: InputInspection;
  sourcePath?: string;
  resolvedPath?: string;
  diagnoses: DependencyDiagnosis[];
  strategies: InstallStrategy[];
  installSummary?: string[];
}): string {
  const missing = options.diagnoses.filter((diagnosis) => !diagnosis.installed);
  const relevantMissing = missing.filter((diagnosis) => diagnosis.relevant);
  const lines = ["docparser doctor", `Platform: ${getPlatformLabel()}`];

  if (options.sourcePath) {
    lines.push(`Target: ${options.sourcePath}`);
  }

  if (options.resolvedPath && options.resolvedPath !== options.sourcePath) {
    lines.push(`Resolved path: ${options.resolvedPath}`);
  }

  if (options.inspection) {
    lines.push(`Detected input type: ${getInputCategoryLabel(options.inspection.category)}`);
    if (options.inspection.extension) {
      lines.push(`Detected extension: ${options.inspection.extension}`);
    }
  }

  if (options.inspection && getRelevantDependencyNames(options.inspection).size === 0) {
    lines.push(
      "This input type does not require extra host conversion packages for normal parsing.",
    );
  } else if (relevantMissing.length > 0) {
    lines.push("Action needed: install the missing packages listed below.");
  } else if (missing.length > 0) {
    lines.push(
      "Optional host packages are missing. Install them if you plan to parse inputs that need them.",
    );
  } else {
    lines.push("All relevant host dependencies are installed.");
  }

  lines.push("Dependency status:");
  for (const diagnosis of options.diagnoses) {
    const status = diagnosis.installed
      ? diagnosis.detectedCommand
        ? `installed (${diagnosis.detectedCommand})`
        : "installed"
      : diagnosis.relevant
        ? options.inspection
          ? "missing — required for this input"
          : "missing — relevant"
        : "missing — optional";

    lines.push(`- ${diagnosis.label}: ${status}`);
    lines.push(`  ${diagnosis.summary}`);
  }

  if (options.installSummary?.length) {
    lines.push("Installation attempt:");
    for (const line of options.installSummary) {
      const [firstLine, ...rest] = line.split("\n");
      lines.push(`- ${firstLine}`);
      for (const continuation of rest) {
        lines.push(`  ${continuation}`);
      }
    }
  }

  if (missing.length > 0) {
    const preferredStrategies = getPreferredStrategies(options.strategies);
    if (preferredStrategies.length > 0) {
      lines.push("Suggested setup commands:");
      for (const strategy of preferredStrategies.slice(0, 2)) {
        lines.push(`- ${strategy.label}:`);
        for (const command of strategy.commands) {
          lines.push(`  ${command.display}`);
        }
        if (strategy.autoRunBlockedReason) {
          lines.push(`  Note: ${strategy.autoRunBlockedReason}`);
        }
      }
    } else if (process.platform === "linux") {
      lines.push(
        "Suggested setup: install the missing packages with your distribution package manager.",
      );
    } else if (process.platform === "darwin") {
      lines.push(
        "Suggested setup: install Homebrew, then run the appropriate brew install commands.",
      );
    } else if (process.platform === "win32") {
      lines.push("Suggested setup: use winget or Chocolatey to install the missing packages.");
    }
  }

  return lines.join("\n");
}

async function collectDoctorState(inspection?: InputInspection): Promise<{
  diagnoses: DependencyDiagnosis[];
  missingDependencies: DependencyDiagnosis[];
  installCandidates: DependencyDiagnosis[];
  strategies: InstallStrategy[];
}> {
  const diagnoses = await diagnoseDependencies(inspection);
  const missingDependencies = diagnoses.filter((diagnosis) => !diagnosis.installed);
  const installCandidates = inspection
    ? missingDependencies.filter((diagnosis) => diagnosis.relevant)
    : missingDependencies;
  const strategyInput = installCandidates.length > 0 ? installCandidates : missingDependencies;

  return {
    diagnoses,
    missingDependencies,
    installCandidates,
    strategies: await buildInstallStrategies(strategyInput),
  };
}

async function selectInstallStrategy(
  strategies: InstallStrategy[],
  ctx: ExtensionCommandContext,
): Promise<InstallStrategy | undefined> {
  if (strategies.length === 1) {
    return strategies[0];
  }

  const labels = strategies.map((strategy) => strategy.label);
  const selectedLabel = await ctx.ui.select("Choose an install strategy", labels);
  if (!selectedLabel) {
    return undefined;
  }

  return strategies.find((strategy) => strategy.label === selectedLabel);
}

async function runInstallCommands(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  commands: InstallCommandSpec[],
): Promise<string[]> {
  const runInstallLoop = async () => {
    const installSummary: string[] = [];

    for (const command of commands) {
      const result = await pi.exec(command.command, command.args, {
        timeout: command.timeoutMs ?? INSTALL_COMMAND_TIMEOUT_MS,
      });
      const success = result.code === 0 && !result.killed;

      installSummary.push(
        `${command.description}: ${success ? "ok" : `failed (exit ${result.code}${result.killed ? ", killed" : ""})`}`,
      );

      if (!success) {
        const outputSummary = summarizeInstallOutput(result.stdout, result.stderr);
        if (outputSummary) {
          installSummary.push(`Command output:\n${outputSummary}`);
        }
      }
    }

    return installSummary;
  };

  let ranCustomUi = false;
  let installSummary: string[] | undefined;
  let installError: unknown;

  await ctx.ui.custom<boolean | undefined>((tui, theme, _kb, done) => {
    ranCustomUi = true;

    const loader = new BorderedLoader(
      tui,
      theme,
      "Installing missing packages. Please do not quit pi until this finishes.",
      { cancellable: false },
    );

    runInstallLoop()
      .then((summary) => {
        installSummary = summary;
        done(true);
      })
      .catch((error) => {
        installError = error;
        done(false);
      });

    return loader;
  });

  if (!ranCustomUi) {
    ctx.ui.notify(
      "Installing missing packages. This can take a few minutes. Please wait for the final doctor report.",
      "info",
    );
    return runInstallLoop();
  }

  if (installError) {
    throw installError;
  }

  return installSummary ?? [];
}

export function registerDoctorCommand(pi: ExtensionAPI) {
  pi.registerCommand(DOCTOR_COMMAND_NAME, {
    description:
      "Diagnose docparser host dependencies and optionally try to install missing packages",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const normalizedArg = normalizeDoctorArgument(args);

      if (normalizedArg === "help" || normalizedArg === "--help") {
        ctx.ui.notify(
          [
            `${DOCTOR_COMMAND} usage`,
            `- ${DOCTOR_COMMAND}`,
            `- ${DOCTOR_COMMAND} @path/to/file.docx`,
            "",
            "With a file path, the doctor focuses on the dependencies relevant to that input.",
          ].join("\n"),
          "info",
        );
        return;
      }

      await ctx.waitForIdle();

      try {
        let target: Awaited<ReturnType<typeof resolveDocumentTarget>> | undefined;
        try {
          target = normalizedArg ? await resolveDocumentTarget(normalizedArg, ctx.cwd) : undefined;
        } catch {
          if (normalizedArg) {
            ctx.ui.notify(`Document file not found or not readable: ${normalizedArg}`, "error");
          }
          return;
        }

        const initialState = await collectDoctorState(target?.inspection);
        const initialReport = formatDoctorReport({
          inspection: target?.inspection,
          sourcePath: target?.sourcePath,
          resolvedPath: target?.resolvedPath,
          diagnoses: initialState.diagnoses,
          strategies: initialState.strategies,
        });
        ctx.ui.notify(initialReport, "info");

        if (
          initialState.missingDependencies.length === 0 ||
          initialState.installCandidates.length === 0
        ) {
          return;
        }

        const autoRunnableStrategies = getPreferredStrategies(
          initialState.strategies.filter((strategy) => strategy.autoRunnable),
        );
        if (autoRunnableStrategies.length === 0) {
          ctx.ui.notify(
            `No automatic install strategy is safely available right now. Follow the suggested commands above or install the packages manually, then rerun ${DOCTOR_COMMAND}.`,
            "warning",
          );
          return;
        }

        const selectedStrategy = await selectInstallStrategy(autoRunnableStrategies, ctx);
        if (!selectedStrategy) {
          return;
        }

        const installList = initialState.installCandidates
          .map((dependency) => dependency.label)
          .join(", ");
        const confirmText = [
          `Missing packages: ${installList}`,
          `Installer: ${selectedStrategy.label}`,
          "",
          "Commands that will be attempted:",
          ...selectedStrategy.commands.map((command) => `- ${command.display}`),
          "",
          "Try running them now?",
        ].join("\n");

        const confirmed = await ctx.ui.confirm("docparser doctor", confirmText);
        if (!confirmed) {
          return;
        }

        const installSummary = await runInstallCommands(pi, ctx, selectedStrategy.commands);

        const finalState = await collectDoctorState(target?.inspection);
        const finalReport = formatDoctorReport({
          inspection: target?.inspection,
          sourcePath: target?.sourcePath,
          resolvedPath: target?.resolvedPath,
          diagnoses: finalState.diagnoses,
          strategies: finalState.strategies,
          installSummary,
        });
        ctx.ui.notify(finalReport, "info");
      } catch (error) {
        ctx.ui.notify(
          `docparser doctor failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
