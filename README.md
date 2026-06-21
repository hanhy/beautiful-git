# IDEA Merge Resolver

A local VS Code extension that opens Git conflict-marker files in an IntelliJ IDEA-style three-pane merge editor.

## Features

- Left / Result / Right layout inspired by IDEA's merge dialog.
- IntelliJ IDEA-style directory context menu: `Git > Commit Files...` and `Git > Resolve Conflicts...`.
- Sidebar commit panel with changed-file checkboxes, commit message input, `Commit`, and `Commit & Push`.
- Resolve Conflicts dialog listing all conflicted files in the selected directory.
- Line-number gutter action to toggle per-line Git blame annotations.
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

### Commit Files

1. Open a Git repository in VS Code.
2. Right-click a directory in Explorer.
3. Choose `Git > Commit Files...`.
4. In the left sidebar Commit panel, select the files you want to commit.
5. Type the commit message at the bottom.
6. Click `Commit` for a local commit, or `Commit & Push` to commit and push.

### Resolve Conflicts

1. Open a Git repository that has merge conflicts.
2. Right-click a directory in Explorer.
3. Choose `Git > Resolve Conflicts...`.
4. In the conflict list, choose one of these actions:
   - `Accept Yours` to resolve the whole file with the left/current side.
   - `Accept Theirs` to resolve the whole file with the right/incoming side.
   - `Merge...` to open the three-pane IDEA-style merge editor.
5. In the merge editor, choose `Left`, `Right`, or `Both`, or edit the Result text manually.
6. Click `Apply` to write the resolved content back to the file.
7. Review the file, then run `git add <file>` and continue your merge or rebase.

### Open One File Directly

1. Open a conflicted file containing conflict markers such as `<<<<<<<`, `=======`, and `>>>>>>>`.
2. Run `IDEA Merge Resolver: Open Current File` from the command palette.
3. In the merge view:
   - Click `Left` to use the current branch's block.
   - Click `Right` to use the incoming branch's block.
   - Click `Both` to keep both sides.
   - Edit the Result text area manually if needed.
4. Click `Apply` to write the resolved content back to the file.
5. Review the file, then run `git add <file>` and continue your merge or rebase.

You can also right-click a file in the Explorer and choose `Open in IDEA Merge Resolver`.

### Git Blame Annotations

1. Open a tracked file in a Git repository.
2. Right-click the editor line-number gutter or the editor body.
3. Choose `Annotate with Git Blame`.
4. Each line shows the most recent commit date and author before the code. Newer commits use a deeper blue background.
5. Right-click again and choose `Close Annotation` to hide it.

## Commands

- `IDEA Merge Resolver: Open Current File`
- `Open in IDEA Merge Resolver`
- `Commit Files...`
- `Resolve Conflicts...`
- `Annotate with Git Blame`
- `Close Annotation`

## Development

```bash
npm test
npm run check
```
