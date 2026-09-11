# Brown Dust 2 L2D Viewer

Website to check the animations of the characters from the gacha game Brown Dust 2.<br/>
If you want to request a feature or report a bug you can open an issue.

## Donations

If you like the work and effort I put into the website and want to help me consider [supporting](https://ko-fi.com/jelosus1).

## License

MIT License

Copyright (c) 2025 Jelosus2

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Fork Additions

This fork adds the following features on top of the original project.

### Loading External Models

You can load your own Spine models without touching the source code. Create an
`external-models.yaml` file at the project root and list the folders to scan:

```yaml
paths:
  - C:/path/to/your/models
```

While running `pnpm dev`, the dev server scans those folders for Spine models —
a `.atlas` file together with a `.skel` (binary or JSON) skeleton and its texture
images — and lists them in the character sidebar with an EX badge.

- The folder name is used as the display name. A folder with several atlases
  produces one entry per atlas (`Name`, `Name_2`, ...).
- If an external model's name matches an in-game character, it inherits that
  character's costume name, voice lines and icon. Matching is fuzzy, so minor
  naming differences are tolerated.
- Backgrounds are picked up automatically: any image with "back" in its filename,
  or images inside a `textures/` subfolder, and applied as the character's
  background.
- External models are served by the local dev server, so they only appear while
  `pnpm dev` is running.

### Fullscreen Viewer

A fullscreen toggle was added to the player toolbar (native Fullscreen API with a
CSS fallback). In fullscreen, the toolbar and timeline fade out after a short
period of inactivity and the cursor hides; moving the mouse brings them back.

### A-B Loop

Set A and B points at the current playhead to loop a specific section of an
animation. The active range is highlighted on the timeline. It works with both
regular animations and cutscene sequences, and exports (video and image
sequence) respect the A-B range. The loop clears automatically when switching
character or category, or when seeking outside the range.

### Other Improvements

- The animation list can be focused and navigated with the up/down arrow keys
  (the current entry scrolls into view).
- A button to reset the animation speed back to 1.00x.
- Double-click a character name to copy it; long names wrap instead of being cut
  off.
