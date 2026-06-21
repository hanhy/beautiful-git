# IDEA Merge Resolver

A local VS Code extension that opens Git conflict-marker files in an IntelliJ IDEA-style three-pane merge editor.

## Features

- Left / Result / Right layout inspired by IDEA's merge dialog.
- Opens from the editor title or Explorer context menu.
- Parses standard Git conflict markers, including optional `||||||| base` sections.
- Accept one conflict from the left or right side, accept both, or apply all left/right changes.
- Edit the result block manually before applying.
- Writes the resolved file back without conflict markers.

## Run Locally

1. Open this folder in VS Code:

   ```bash
   code /Users/huiyang.han/Documents/QUANT/idea-merge-resolver
   ```

2. Press `F5` and choose `Run IDEA Merge Resolver`.
3. In the Extension Development Host, open `fixtures/conflict-sample.txt`.
4. Run `IDEA Merge Resolver: Open Current File` from the command palette.

## Commands

- `IDEA Merge Resolver: Open Current File`
- `Open in IDEA Merge Resolver`

## Development

```bash
npm test
npm run check
```
