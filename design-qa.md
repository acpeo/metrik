**Findings**
- No remaining P0/P1/P2 visual mismatch is visible in the accepted large-widget state.
- [P3] The local ad-hoc preview uses fixture data (`89% / 30.4M`) because an Apple-signed App Group is unavailable before release signing. This does not affect layout or WidgetKit material validation; live bridge validation remains a release-integration check.

**Comparison Evidence**
- Source visual truth: `design/reference-macos-desktop-widget-focus-dial-320.png`.
- Native implementation: `design/shot-widgetkit-restored-style-native-final-crop.jpg`.
- Required combined input: `design/qa-widgetkit-restored-style-comparison-approved.png` (approved reference left, WidgetKit implementation right).
- Native host: `/Applications/Metrik Widget Preview.app`.
- Native extension: `/Applications/Metrik Widget Preview.app/Contents/PlugIns/MetrikWidget.appex`.
- Widget family/state: `systemLarge`, light appearance, `zh_CN`, `displayScale(2.0)`, `reduceTransparency(false)`.
- Native family dimensions: `344 x 344` points. The QA crop is `362 x 362` pixels because it retains the Simulator's outer shadow/padding.
- Data mismatch: source uses `72% / 1.28M / 2 Agents`; implementation uses `89% / 30.4M / 6 Agents`. The anatomy, typography tracks and safe areas are directly comparable.

**Full-View Comparison**
- Preserved anatomy: Metrik header/status dot; left quota dial; right provider/today/tokens summary; inset Agent switcher; update/expanded-view footer.
- The only intentional density adaptation is the Agent switcher: the accepted two full-width rows become a two-column, three-row grid so all six selected Agents remain visible.
- WidgetKit now owns the single outer container, native corner shape, content margins and semantic material. There is no second painted outer card and no Metrik opacity percentage for the desktop widget.

**Focused-Region Comparison**
- Dial copy follows the reference's vertical order: `ChatGPT`, window/remaining label, complete serif percentage, reset countdown.
- The complete `89%` reading is one centered object at `32pt`; the Agent copy is lowered by `6pt` relative to the ring center and does not touch the blue stroke.
- The arc uses a `5.5pt` rounded stroke and a fixed inner text width of `88pt`; neither the title nor reset copy enters its painted envelope.
- The token number uses the same serif role as the approved reference while labels and Agent rows remain system sans-serif.

**Interaction and Native Verification**
- WidgetKit Simulator reloaded the installed extension and exposed the expected accessibility content: `ChatGPT 每周`, `剩余 89 百分比`, `30.4M tokens`, and all six Agents.
- `MetrikOverviewWidget` advertises `systemMedium` and `systemLarge`; the large family rendered without clipping or overflow.
- `pluginkit` registers `app.metrik.desktop.widget-preview.widget` from the installed host.
- Deep code-sign verification passes; the extension's Mach-O entry point resolves through `_NSExtensionMain`.
- Swift WidgetKit type checking, frontend tests/build, Rust formatting, Clippy and Rust tests pass.

**Comparison History**
- Native pass 1 — P1: generic six-row overview changed the accepted design. Restored the approved card anatomy.
- Native pass 2 — P1: the system gauge compressed the ring and overlaid the dial copy. Replaced it with a controlled SwiftUI progress arc and explicit safe area.
- Native pass 3 — P2: the dial stroke was heavier than the source and the ChatGPT copy sat slightly high. Reduced the stroke to `5.5pt`, moved the copy down, and restored serif display numerals.
- Native pass 4 — passed: source and native screenshot compared in one input; no text/arc collision, clipping, extra outer corner or missing Agent remains.

**Follow-up Polish**
- None required before user visual approval. Real quota publication through the production App Group should be validated when the release target is signed.

final result: passed
