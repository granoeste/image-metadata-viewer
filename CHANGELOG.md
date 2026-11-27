# Changelog

All notable changes to the Image Metadata Viewer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ComfyUI workflow export: save the UI-format `workflow` or API-format `prompt` as JSON (panel buttons / `Export ComfyUI Workflow` command in Explorer context menu)
- ComfyUI node graph analysis: "Workflow Nodes" section listing every node in dependency order with its parameters and input links

### Fixed

- Large ComfyUI `workflow` chunks beyond the first 64KB were dropped when the `prompt` chunk fit within it

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