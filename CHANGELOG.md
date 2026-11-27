# Changelog

All notable changes to the Image Metadata Viewer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-27

### Added

- ComfyUI workflow export: save the UI-format `workflow` or API-format `prompt` as JSON (panel buttons / `Export ComfyUI Workflow` command in Explorer context menu and Command Palette)
- ComfyUI node graph analysis: "Workflow Nodes" section listing every node in dependency order with its parameters and input links
- PNGs that contain only a ComfyUI `workflow` (no API `prompt`) are now recognized as ComfyUI images

### Changed

- ComfyUI prompt extraction follows linked nodes: primitive / string nodes, switch nodes (only the active branch), `StringReplace` / `StringConcatenate`, and pass-through nodes such as `PreviewAny`
- ComfyUI prompt extraction supports encoders other than `CLIPTextEncode` (e.g. `CLIPTextEncodeSDXL`, `MiniMaxH3ImageConditioning`), `ControlNetApplyAdvanced` positive/negative outputs, and `SamplerCustomAdvanced` with `CFGGuider` / `BasicGuider`
- ComfyUI image size is read from any `Empty*Latent*` node (values linked from primitive nodes included), falling back to the PNG's own dimensions (e.g. image-edit workflows)
- The "Export API Prompt" button is shown only when the image contains an API prompt

### Fixed

- Large ComfyUI `workflow` chunks beyond the first 64KB were dropped when the `prompt` chunk fit within it
- Positive prompt was empty for workflows whose prompt reaches the sampler through intermediate nodes

## [1.0.0] - 2026-03-18

### Added

- Stable Diffusion metadata display (A1111 format) from PNG tEXt chunks
- ComfyUI node graph metadata display from PNG tEXt chunks
- JPEG EXIF data display with categorized view (Camera, Shooting, Image, GPS, Other)
- Thumbnail preview in the metadata panel
- Copy buttons for prompts, settings rows, and raw data
- Auto-sync with active editor tab
- Support for PNG and JPEG files
- Nonce-based Content Security Policy for webview security
- VS Code theme integration using native theme variables