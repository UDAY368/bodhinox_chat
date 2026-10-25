# Flow Studio — cream and copper

The user selected the AiSensy-style editor layout with Bodhinox's existing cream and copper palette. Reuse the current React Flow canvas, shared node forms, editor context, save/activation paths, and runtime.

Design: a searchable grouped block library at left; a spacious dotted canvas with message previews and labeled output connections; a persistent right inspector that updates the selected node without covering the canvas. Compact toolbar and collapsible flow settings. List view stays available and remains the mobile editing experience. Existing positions remain intact; an explicit Arrange action can lay out the graph.

Implementation: add a tested block search helper; update canvas composition, node cards, and inspector using existing components; compact the editor shell; add scoped responsive styles and translated labels. Verify search, node creation, selection, editing, connection preservation, Canvas/List transitions, existing validation, typecheck, lint, build, and browser rendering. No execution, credential, API contract, or schema changes. Preview locally before considering production deployment.
