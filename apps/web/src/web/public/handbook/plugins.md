# Optional chat plugins

Open Plugins in the conversation header. LaTeX, Python and Modelica are independent preferences for this browser and default to off. Switching them off removes their controls; existing message and code source remains available.

## Math previews

Enable LaTeX for math rendering and source/preview controls. In the composer, Preview math shows the rendered draft and Edit source returns to the text. The source remains the message that will be sent. Previewing a formula does not verify its mathematics.

## Python and Modelica

1. Enable the language plugin. An assistance button appears beside explicitly labelled code fences: `python` or `py`, and `modelica` or `mo`. Unlabelled code is not guessed.
2. Select Python assistance or Modelica assistance to open a scratch copy. Editing it leaves the original message unchanged.
3. Select Check for diagnostics, Complete for suggestions at the cursor, or Hover for type information. Suggestions appear as text and are not applied automatically.
4. Close the editor to discard the draft. Disabling the plugin also cancels outstanding requests and closes its editors.

Assistance requires an owner sign-in and an operator-configured local language server: Pyright for Python or Rumoca for Modelica. Each action sends the snippet and cursor to this Reverie website, then uses a temporary language-server workspace. Code is not executed, and the draft is not sent to an agent or model provider. Standalone snippets can lack imports and project-wide type information.

Enabling a browser preference does not install tools. If assistance is unavailable, ask the operator to check `docs/chat-plugins.md`; do not paste credentials into a snippet. That guide covers the optional server image and native server packages. Language servers are optional and separate from the default runtime.

See [Work and scratch](/handbook/work) for files and deliverables, and [Permissions](/handbook/permissions) for access boundaries.
