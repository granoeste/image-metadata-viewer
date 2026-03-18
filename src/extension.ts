import * as vscode from 'vscode';
import * as path from 'path';
import { readPngMetadata } from './pngReader';
import { parseSDParameters } from './metadataParser';
import { parseComfyUIPrompt } from './comfyuiParser';
import { readExifData } from './exifReader';
import { getSDWebviewContent, getComfyUIWebviewContent, getExifWebviewContent, getNoMetadataHtml } from './webviewContent';

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

let currentPanel: vscode.WebviewPanel | undefined;

function getImageUriFromTab(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  if (!tab?.input) { return undefined; }
  const uri: vscode.Uri | undefined = (tab.input as any).uri;
  if (uri && SUPPORTED_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) {
    return uri;
  }
  return undefined;
}

async function updatePanel(uri: vscode.Uri): Promise<void> {
  if (!currentPanel) { return; }

  const ext = path.extname(uri.fsPath).toLowerCase();
  const fileName = path.basename(uri.fsPath);

  // Update localResourceRoots
  currentPanel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.dirname(uri.fsPath))],
  };

  try {
    // PNG → SD metadata or ComfyUI metadata
    if (ext === '.png') {
      const chunks = await readPngMetadata(uri.fsPath);

      // A1111-style SD metadata
      const raw = chunks.get('parameters');
      if (raw) {
        const metadata = parseSDParameters(raw);
        currentPanel.title = `SD: ${fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName}`;
        currentPanel.webview.html = getSDWebviewContent(currentPanel.webview, uri, metadata);
        return;
      }

      // ComfyUI metadata
      const comfyPrompt = chunks.get('prompt');
      if (comfyPrompt) {
        const comfyWorkflow = chunks.get('workflow') || '';
        const metadata = parseComfyUIPrompt(comfyPrompt, comfyWorkflow);
        currentPanel.title = `ComfyUI: ${fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName}`;
        currentPanel.webview.html = getComfyUIWebviewContent(currentPanel.webview, uri, metadata);
        return;
      }
    }

    // JPEG → EXIF
    if (JPEG_EXTENSIONS.has(ext)) {
      const exif = await readExifData(uri.fsPath);
      if (exif && Object.keys(exif).length > 0) {
        currentPanel.title = `EXIF: ${fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName}`;
        currentPanel.webview.html = getExifWebviewContent(currentPanel.webview, uri, exif);
        return;
      }
    }

    // No metadata found
    currentPanel.title = `Info: ${fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName}`;
    currentPanel.webview.html = getNoMetadataHtml();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to read metadata: ${err.message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const command = vscode.commands.registerCommand('imageMetadata.show', async (uri?: vscode.Uri) => {
    // Resolve URI: from context menu, editor title, or active tab
    if (!uri) {
      uri = getImageUriFromTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    }

    if (!uri) {
      vscode.window.showWarningMessage('No supported image file selected.');
      return;
    }

    const ext = path.extname(uri.fsPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      vscode.window.showWarningMessage('Unsupported file type. Supported: PNG, JPG, JPEG.');
      return;
    }

    // Reuse existing panel or create a new one
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      currentPanel = vscode.window.createWebviewPanel(
        'imageMetadata',
        'Image Metadata',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.dirname(uri.fsPath))],
        }
      );

      currentPanel.webview.onDidReceiveMessage((message) => {
        if (message.type === 'info') {
          vscode.window.showInformationMessage(message.text);
        } else if (message.type === 'copy') {
          vscode.env.clipboard.writeText(message.text).then(() => {
            vscode.window.showInformationMessage('Copied to clipboard!');
          });
        }
      });

      currentPanel.onDidDispose(() => {
        currentPanel = undefined;
      });
    }

    await updatePanel(uri);
  });

  // Auto-sync: update panel when active tab changes to a supported image
  const tabChangeListener = vscode.window.tabGroups.onDidChangeTabGroups(async () => {
    if (!currentPanel) { return; }
    const uri = getImageUriFromTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (uri) {
      await updatePanel(uri);
    }
  });

  // Also listen to active editor changes (covers switching between already-open tabs)
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(async () => {
    if (!currentPanel) { return; }
    const uri = getImageUriFromTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (uri) {
      await updatePanel(uri);
    }
  });

  context.subscriptions.push(command, tabChangeListener, editorChangeListener);
}

export function deactivate() {}
