import * as vscode from "vscode";
import { SDMetadata } from "./metadataParser";
import { ComfyUIMetadata } from "./comfyuiParser";
import { ExifData } from "./exifReader";

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getSDWebviewContent(
  webview: vscode.Webview,
  imageUri: vscode.Uri,
  metadata: SDMetadata,
): string {
  const imageWebviewUri = webview.asWebviewUri(imageUri);
  const nonce = getNonce();

  const settingsRows = Object.entries(metadata.settings)
    .map(
      ([key, value]) =>
        `<tr><td class="key">${escapeHtml(key)}</td><td class="value">${escapeHtml(value)}</td><td class="copy-cell"><button class="copy-row-btn" data-copy="${escapeHtml(value)}" title="Copy ${escapeHtml(key)}">Copy</button></td></tr>`,
    )
    .join("\n");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${commonStyles()}
</head>
<body>
  <img class="thumbnail" src="${imageWebviewUri}" alt="Preview" />
  <span class="badge sd">SD Metadata</span>

  <div class="section-header">
    <h2>Positive Prompt</h2>
    <button class="copy-btn" data-copy-id="positive">Copy</button>
  </div>
  <div class="prompt-block" id="positive">${escapeHtml(metadata.positivePrompt)}</div>

  ${
    metadata.negativePrompt
      ? `
  <div class="negative">
    <div class="section-header">
      <h2>Negative Prompt</h2>
      <button class="copy-btn" data-copy-id="negative">Copy</button>
    </div>
    <div class="prompt-block" id="negative">${escapeHtml(metadata.negativePrompt)}</div>
  </div>
  `
      : ""
  }

  ${
    settingsRows
      ? `
  <h2>Generation Settings</h2>
  <table>${settingsRows}</table>
  `
      : ""
  }

  <details>
    <summary>Raw Metadata</summary>
    <button class="copy-btn" data-copy-id="raw" style="margin-top:4px">Copy Raw</button>
    <div class="prompt-block" id="raw">${escapeHtml(metadata.raw)}</div>
  </details>

  ${copyScript(nonce)}
</body>
</html>`;
}

export function getComfyUIWebviewContent(
  webview: vscode.Webview,
  imageUri: vscode.Uri,
  metadata: ComfyUIMetadata,
): string {
  const imageWebviewUri = webview.asWebviewUri(imageUri);
  const nonce = getNonce();

  const settingsRows = Object.entries(metadata.settings)
    .map(
      ([key, value]) =>
        `<tr><td class="key">${escapeHtml(key)}</td><td class="value">${escapeHtml(value)}</td><td class="copy-cell"><button class="copy-row-btn" data-copy="${escapeHtml(value)}" title="Copy ${escapeHtml(key)}">Copy</button></td></tr>`,
    )
    .join("\n");

  // Format raw JSON for display
  let formattedPrompt = metadata.rawPrompt;
  try {
    formattedPrompt = JSON.stringify(JSON.parse(metadata.rawPrompt), null, 2);
  } catch {}

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${commonStyles()}
</head>
<body>
  <img class="thumbnail" src="${imageWebviewUri}" alt="Preview" />
  <span class="badge comfyui">ComfyUI</span>

  <div class="section-header">
    <h2>Positive Prompt</h2>
    <button class="copy-btn" data-copy-id="positive">Copy</button>
  </div>
  <div class="prompt-block" id="positive">${escapeHtml(metadata.positivePrompt || "(none)")}</div>

  ${
    metadata.negativePrompt
      ? `
  <div class="negative">
    <div class="section-header">
      <h2>Negative Prompt</h2>
      <button class="copy-btn" data-copy-id="negative">Copy</button>
    </div>
    <div class="prompt-block" id="negative">${escapeHtml(metadata.negativePrompt)}</div>
  </div>
  `
      : ""
  }

  ${
    settingsRows
      ? `
  <h2>Generation Settings</h2>
  <table>${settingsRows}</table>
  `
      : ""
  }

  <details>
    <summary>Raw Prompt (JSON)</summary>
    <button class="copy-btn" data-copy-id="raw-prompt" style="margin-top:4px">Copy</button>
    <div class="prompt-block raw-json" id="raw-prompt">${escapeHtml(formattedPrompt)}</div>
  </details>

  ${
    metadata.rawWorkflow
      ? `
  <details>
    <summary>Raw Workflow (JSON)</summary>
    <button class="copy-btn" data-copy-id="raw-workflow" style="margin-top:4px">Copy</button>
    <div class="prompt-block raw-json" id="raw-workflow">${escapeHtml(metadata.rawWorkflow)}</div>
  </details>
  `
      : ""
  }

  ${copyScript(nonce)}
</body>
</html>`;
}

export function getExifWebviewContent(
  webview: vscode.Webview,
  imageUri: vscode.Uri,
  exif: ExifData,
): string {
  const imageWebviewUri = webview.asWebviewUri(imageUri);
  const nonce = getNonce();

  // Group EXIF tags into categories
  const camera: [string, string][] = [];
  const shooting: [string, string][] = [];
  const image: [string, string][] = [];
  const gps: [string, string][] = [];
  const other: [string, string][] = [];

  const cameraKeys = new Set([
    "Make",
    "Model",
    "BodySerialNumber",
    "LensMake",
    "LensModel",
    "LensInfo",
    "Software",
  ]);
  const shootingKeys = new Set([
    "ExposureTime",
    "FNumber",
    "ISO",
    "FocalLength",
    "FocalLengthIn35mmFilm",
    "ExposureBiasValue",
    "MeteringMode",
    "Flash",
    "SceneCaptureType",
    "ShutterSpeedValue",
    "ApertureValue",
  ]);
  const imageKeys = new Set([
    "PixelXDimension",
    "PixelYDimension",
    "Orientation",
    "ColorSpace",
    "XResolution",
    "YResolution",
    "DateTime",
    "DateTimeOriginal",
    "DateTimeDigitized",
    "ImageDescription",
    "Artist",
    "Copyright",
  ]);
  const gpsKeys = new Set(["GPS", "GPSAltitude"]);

  for (const [key, value] of Object.entries(exif)) {
    const entry: [string, string] = [key, value];
    if (cameraKeys.has(key)) {
      camera.push(entry);
    } else if (shootingKeys.has(key)) {
      shooting.push(entry);
    } else if (imageKeys.has(key)) {
      image.push(entry);
    } else if (gpsKeys.has(key)) {
      gps.push(entry);
    } else {
      other.push(entry);
    }
  }

  const makeTable = (rows: [string, string][]) =>
    rows
      .map(
        ([k, v]) =>
          `<tr><td class="key">${escapeHtml(formatExifLabel(k))}</td><td class="value">${escapeHtml(v)}</td><td class="copy-cell"><button class="copy-row-btn" data-copy="${escapeHtml(v)}" title="Copy ${escapeHtml(formatExifLabel(k))}">Copy</button></td></tr>`,
      )
      .join("\n");

  const sections: string[] = [];
  if (camera.length) {
    sections.push(`<h2>Camera</h2><table>${makeTable(camera)}</table>`);
  }
  if (shooting.length) {
    sections.push(`<h2>Shooting</h2><table>${makeTable(shooting)}</table>`);
  }
  if (image.length) {
    sections.push(`<h2>Image</h2><table>${makeTable(image)}</table>`);
  }
  if (gps.length) {
    sections.push(`<h2>GPS</h2><table>${makeTable(gps)}</table>`);
  }
  if (other.length) {
    sections.push(`<h2>Other</h2><table>${makeTable(other)}</table>`);
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${commonStyles()}
</head>
<body>
  <img class="thumbnail" src="${imageWebviewUri}" alt="Preview" />
  <span class="badge exif">EXIF</span>
  ${sections.join("\n")}
  ${copyScript(nonce)}
</body>
</html>`;
}

export function getNoMetadataHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    margin: 0;
    opacity: 0.5;
  }
</style>
</head>
<body>
  <p>No metadata found</p>
</body>
</html>`;
}

function formatExifLabel(key: string): string {
  const labels: Record<string, string> = {
    Make: "Make",
    Model: "Model",
    LensMake: "Lens Make",
    LensModel: "Lens Model",
    LensInfo: "Lens Info",
    BodySerialNumber: "Serial Number",
    Software: "Software",
    ExposureTime: "Exposure",
    FNumber: "Aperture",
    ISO: "ISO",
    FocalLength: "Focal Length",
    FocalLengthIn35mmFilm: "Focal Length (35mm)",
    ExposureBiasValue: "Exposure Bias",
    MeteringMode: "Metering",
    Flash: "Flash",
    SceneCaptureType: "Scene Type",
    ShutterSpeedValue: "Shutter Speed",
    ApertureValue: "Aperture Value",
    PixelXDimension: "Width",
    PixelYDimension: "Height",
    Orientation: "Orientation",
    ColorSpace: "Color Space",
    XResolution: "X Resolution",
    YResolution: "Y Resolution",
    DateTime: "Date/Time",
    DateTimeOriginal: "Date Taken",
    DateTimeDigitized: "Date Digitized",
    ImageDescription: "Description",
    Artist: "Artist",
    Copyright: "Copyright",
    GPS: "Coordinates",
    GPSAltitude: "Altitude",
    ExifVersion: "EXIF Version",
  };
  return labels[key] || key;
}

function copyScript(nonce: string): string {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // Copy by element id (for prompt blocks)
    document.querySelectorAll('[data-copy-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.copyId);
        if (el) {
          vscode.postMessage({ type: 'copy', text: el.textContent || '' });
        }
      });
    });
    // Copy by data attribute (for table rows)
    document.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copy', text: btn.dataset.copy });
      });
    });
  </script>`;
}

function commonStyles(): string {
  return `<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    line-height: 1.5;
  }
  .thumbnail {
    display: block;
    max-width: 300px;
    max-height: 400px;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border);
    margin-bottom: 8px;
  }
  .badge {
    display: inline-block;
    font-size: 0.75em;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 3px;
    margin-bottom: 12px;
  }
  .badge.sd {
    background: var(--vscode-textLink-foreground);
    color: var(--vscode-editor-background);
  }
  .badge.comfyui {
    background: var(--vscode-charts-orange, #ff9800);
    color: #fff;
  }
  .badge.exif {
    background: var(--vscode-charts-green, #4caf50);
    color: #fff;
  }
  h2 {
    color: var(--vscode-foreground);
    font-size: 1.1em;
    margin: 16px 0 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    padding-bottom: 4px;
  }
  .prompt-block {
    background: var(--vscode-textBlockQuote-background);
    border-left: 3px solid var(--vscode-textLink-foreground);
    padding: 8px 12px;
    margin: 8px 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.95em;
  }
  .negative .prompt-block {
    border-left-color: var(--vscode-errorForeground);
  }
  .raw-json {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    max-height: 400px;
    overflow: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 8px 0;
  }
  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  td.key {
    font-weight: bold;
    white-space: nowrap;
    width: 1%;
    color: var(--vscode-textLink-foreground);
  }
  td.value {
    word-break: break-all;
  }
  td.copy-cell {
    width: 1%;
    padding: 2px 4px;
  }
  .copy-row-btn {
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 2px;
    padding: 1px 6px;
    cursor: pointer;
    font-size: 0.75em;
    opacity: 0.5;
    transition: opacity 0.15s;
  }
  tr:hover .copy-row-btn {
    opacity: 1;
  }
  .copy-row-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.15));
  }
  .copy-btn {
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 2px;
    padding: 1px 6px;
    cursor: pointer;
    font-size: 0.75em;
    opacity: 0.5;
    transition: opacity 0.15s;
    margin-left: 8px;
  }
  .copy-btn:hover {
    opacity: 1;
    background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.15));
  }
  .section-header {
    display: flex;
    align-items: baseline;
  }
  .section-header h2 {
    margin-bottom: 0;
    border-bottom: none;
    padding-bottom: 0;
  }
  details {
    margin: 8px 0;
  }
  summary {
    cursor: pointer;
    font-weight: bold;
    color: var(--vscode-foreground);
  }
</style>`;
}
