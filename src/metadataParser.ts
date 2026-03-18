export interface SDMetadata {
  positivePrompt: string;
  negativePrompt: string;
  settings: Record<string, string>;
  raw: string;
}

export function parseSDParameters(raw: string): SDMetadata {
  const lines = raw.trimEnd().split('\n');

  // The last line contains comma-separated key:value settings (Steps: 30, Sampler: ...)
  const lastLine = lines[lines.length - 1];
  const hasSettings = /Steps:\s*\d/.test(lastLine);

  const settings: Record<string, string> = {};
  if (hasSettings) {
    const regex = /([\w][\w ]*?):\s*([^,]+)/g;
    let match;
    while ((match = regex.exec(lastLine)) !== null) {
      settings[match[1].trim()] = match[2].trim();
    }
  }

  // Everything before the settings line is prompt content
  const contentLines = hasSettings ? lines.slice(0, -1) : lines;
  const content = contentLines.join('\n');

  // Split on "Negative prompt:"
  const negIdx = content.indexOf('Negative prompt:');
  let positivePrompt: string;
  let negativePrompt: string;

  if (negIdx >= 0) {
    positivePrompt = content.substring(0, negIdx).trim();
    negativePrompt = content.substring(negIdx + 'Negative prompt:'.length).trim();
  } else {
    positivePrompt = content.trim();
    negativePrompt = '';
  }

  return { positivePrompt, negativePrompt, settings, raw };
}
