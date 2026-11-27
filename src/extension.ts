import * as vscode from 'vscode';
import * as path from 'path';
import { readPngMetadata, readPngSize } from './pngReader';
import { parseSDParameters } from './metadataParser';
import { parseComfyUIPrompt } from './comfyuiParser';
import { readExifData } from './exifReader';
import { getSDWebviewContent, getComfyUIWebviewContent, getExifWebviewContent, getNoMetadataHtml } from './webviewContent';

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

let currentPanel: vscode.WebviewPanel | undefined;

/** パネルに表示中の ComfyUI メタデータ（エクスポート用） */
let currentComfyUI: { uri: vscode.Uri; rawPrompt: string; rawWorkflow: string } | undefined;

type ExportKind = 'workflow' | 'api';

/**
 * JSON 文字列を整形する（パース不可ならそのまま返す）。
 */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * ComfyUI の workflow (UI 形式) または prompt (API 形式) を JSON ファイルとして保存する。
 */
async function exportComfyUIJson(
  imageUri: vscode.Uri,
  kind: ExportKind,
  rawPrompt: string,
  rawWorkflow: string,
): Promise<void> {
  const content = kind === 'workflow' ? rawWorkflow : rawPrompt;
  if (!content) {
    vscode.window.showWarningMessage(
      kind === 'workflow'
        ? 'This image does not contain a ComfyUI workflow.'
        : 'This image does not contain a ComfyUI API prompt.',
    );
    return;
  }

  const baseName = path.basename(imageUri.fsPath, path.extname(imageUri.fsPath));
  const suffix = kind === 'workflow' ? '.workflow.json' : '.api.json';
  const defaultUri = vscode.Uri.file(path.join(path.dirname(imageUri.fsPath), baseName + suffix));

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'JSON': ['json'] },
    saveLabel: kind === 'workflow' ? 'Export Workflow' : 'Export API Prompt',
    title: kind === 'workflow' ? 'Export ComfyUI Workflow' : 'Export ComfyUI API Prompt',
  });
  if (!target) { return; }

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(prettyJson(content) + '\n', 'utf-8'));
    const action = await vscode.window.showInformationMessage(
      `Exported: ${path.basename(target.fsPath)}`,
      'Open',
    );
    if (action === 'Open') {
      await vscode.window.showTextDocument(target);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to export: ${err.message}`);
  }
}

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

  currentComfyUI = undefined;

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
      const comfyPrompt = chunks.get('prompt') || '';
      const comfyWorkflow = chunks.get('workflow') || '';
      if (comfyPrompt || comfyWorkflow) {
        const imageSize = await readPngSize(uri.fsPath).catch(() => undefined);
        const metadata = parseComfyUIPrompt(comfyPrompt, comfyWorkflow, imageSize);
        currentComfyUI = { uri, rawPrompt: comfyPrompt, rawWorkflow: comfyWorkflow };
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
        } else if (message.type === 'export') {
          if (currentComfyUI && (message.kind === 'workflow' || message.kind === 'api')) {
            const { uri: imgUri, rawPrompt, rawWorkflow } = currentComfyUI;
            exportComfyUIJson(imgUri, message.kind, rawPrompt, rawWorkflow);
          }
        }
      });

      currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        currentComfyUI = undefined;
      });
    }

    await updatePanel(uri);
  });

  // Export ComfyUI workflow directly (Explorer context menu / editor title / command palette)
  const exportCommand = vscode.commands.registerCommand('imageMetadata.exportComfyUIWorkflow', async (uri?: vscode.Uri) => {
    if (!uri) {
      uri = getImageUriFromTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    }
    if (!uri || path.extname(uri.fsPath).toLowerCase() !== '.png') {
      vscode.window.showWarningMessage('Select a PNG image generated by ComfyUI.');
      return;
    }

    let chunks: Map<string, string>;
    try {
      chunks = await readPngMetadata(uri.fsPath);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to read metadata: ${err.message}`);
      return;
    }
    const rawPrompt = chunks.get('prompt') || '';
    const rawWorkflow = chunks.get('workflow') || '';
    if (!rawPrompt && !rawWorkflow) {
      vscode.window.showWarningMessage('No ComfyUI workflow found in this image.');
      return;
    }

    let kind: ExportKind = rawWorkflow ? 'workflow' : 'api';
    if (rawPrompt && rawWorkflow) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Workflow (UI format)', description: 'ComfyUI にドラッグ＆ドロップで読み込み', exportKind: 'workflow' as ExportKind },
          { label: 'API Prompt (API format)', description: 'ComfyUI /prompt API 用', exportKind: 'api' as ExportKind },
        ],
        { placeHolder: 'Select export format' },
      );
      if (!picked) { return; }
      kind = picked.exportKind;
    }
    await exportComfyUIJson(uri, kind, rawPrompt, rawWorkflow);
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

  context.subscriptions.push(command, exportCommand, tabChangeListener, editorChangeListener);
}

export function deactivate() {}
