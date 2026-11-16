/**
 * Native "pick a folder" dialog for the BroAgentAI bridge.
 *
 * The side panel cannot open an OS folder picker that yields an absolute
 * path, so the bridge shows one on its behalf. Only Windows is implemented;
 * every other case rejects so the panel falls back to a manual path input.
 */

import { execFile } from "node:child_process";

import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";

/** Set to `1` to disable the native dialog (headless hosts, e2e tests). */
export const DISABLE_DIALOG_ENV = "BROAGENTAI_DISABLE_DIALOG";

/**
 * PowerShell script that shows a top-most FolderBrowserDialog and prints the
 * selected path as UTF-8. Prints nothing when the user cancels.
 */
export const WINDOWS_FOLDER_DIALOG_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Pilih folder workspace BroAgentAI'",
  "$dialog.ShowNewFolderButton = $false",
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  "$owner.Dispose()",
].join("; ");

/** Show the native folder picker and resolve with the chosen absolute path. */
export function openFolderDialog(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<{ path: string }> {
  if (env[DISABLE_DIALOG_ENV] === "1" || platform !== "win32") {
    return Promise.reject(
      new WorkspaceError(ErrorCode.INTERNAL_ERROR, "native folder dialog is not available on this host")
    );
  }

  return new Promise((resolve, reject) => {
    // stdout of the child is piped (never inherited): the host's own stdout is
    // reserved for Native Messaging frames.
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_FOLDER_DIALOG_SCRIPT],
      { windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(new WorkspaceError(ErrorCode.INTERNAL_ERROR, `folder dialog failed: ${error.message}`));
          return;
        }
        const path = stdout.trim();
        if (path === "") {
          reject(new WorkspaceError(ErrorCode.OPERATION_CANCELLED, "folder selection cancelled"));
          return;
        }
        resolve({ path });
      }
    );
  });
}
