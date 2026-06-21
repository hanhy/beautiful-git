# IDEA Merge Resolver

A local VS Code extension that opens Git conflict-marker files in an IntelliJ IDEA-style three-pane merge editor.

## Features

- Left / Result / Right layout inspired by IDEA's merge dialog.
- Opens from the editor title or Explorer context menu.
- Parses standard Git conflict markers, including optional `||||||| base` sections.
- Accept one conflict from the left or right side, accept both, or apply all left/right changes.
- Edit the result block manually before applying.
- Writes the resolved file back without conflict markers.

## Install in VS Code

### Option 1: Install from source

Clone the repository:

```bash
git clone https://github.com/hanhy/beautiful-git.git
```

Copy the extension folder into VS Code's local extensions directory:

```bash
mkdir -p ~/.vscode/extensions
cp -R beautiful-git ~/.vscode/extensions/idea-merge-resolver
```

Restart VS Code. The command `IDEA Merge Resolver: Open Current File` should then appear in the command palette.

### Option 2: Run in extension development mode

Use this if you want to modify or debug the extension.

1. Open this folder in VS Code:

   ```bash
   code beautiful-git
   ```

2. Press `F5` and choose `Run IDEA Merge Resolver`.
3. In the Extension Development Host, open `fixtures/conflict-sample.txt`.
4. Run `IDEA Merge Resolver: Open Current File` from the command palette.

## Usage

1. Open a Git repository that has merge conflicts.
2. Open a conflicted file containing conflict markers such as `<<<<<<<`, `=======`, and `>>>>>>>`.
3. Run `IDEA Merge Resolver: Open Current File` from the command palette.
4. In the merge view:
   - Click `Left` to use the current branch's block.
   - Click `Right` to use the incoming branch's block.
   - Click `Both` to keep both sides.
   - Edit the Result text area manually if needed.
5. Click `Apply` to write the resolved content back to the file.
6. Review the file, then run `git add <file>` and continue your merge or rebase.

You can also right-click a file in the Explorer and choose `Open in IDEA Merge Resolver`.

## Commands

- `IDEA Merge Resolver: Open Current File`
- `Open in IDEA Merge Resolver`

## Development

```bash
npm test
npm run check
```
