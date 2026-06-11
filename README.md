# Mobile Sidebar Notes

Open notes or new tabs in the sidebar in the mobile app.
While this plugin works as expected on desktop for loading notes in the sidebar and adds commands, this functionality is already built-in on desktop.

## Features

- Commands to open new empty sidebar tabs (left or right)
- Set specific notes as commands for quick sidebar access (compatible with hotkeys)
- Choose left or right sidebar per note command (right is default for new commands)
- Duplicate prevention for the same note in the same sidebar
- Auto-pin tabs so links open in new tabs instead of replacing the current one
- Autocomplete path suggestions for markdown note paths
- Invalid or missing note paths are flagged and those commands are not registered

## Installation

1. Download the latest release from the Releases page
2. Extract files to `.obsidian/plugins/mobile-sidebar-notes/` in your vault
3. Reload Obsidian and enable the plugin in Settings

## Usage

1. Go to Settings → Mobile Sidebar Notes
2. Click "Add Command" to configure a sidebar note command
3. Enter a display name, note path (autocomplete suggests markdown notes), and choose left or right sidebar
4. Use commands or the new sidebar tab commands to access notes

**or simply:**

1. Run "Open new right sidebar tab" or "Open new left sidebar tab"
2. Open a note in that sidebar tab

### Commands

- **Open [configured title or note path] in [left/right] sidebar**: Opens configured notes in the chosen sidebar
- **Open new right sidebar tab**: Creates empty tab in the right sidebar
- **Open new left sidebar tab**: Creates empty tab in the left sidebar

## Settings

### General

- **Auto-pin tabs**: Automatically pin notes opened in the sidebar so links open in new tabs instead of replacing them (enabled by default)

### Commands

- **Commands**: Add/remove notes to create commands for sidebar access. Each command has a title, note path, and sidebar side selector. Commands are only registered when the note path is valid.

## Tips

- Within the sidebar, press and hold on the dropdown of the note for options such as closing, pinning and renaming.
- Tabs tend to persist between sessions / after opening unless manually closed.
- Duplicate tabs are prevented when opening the same note in the same sidebar.
- This is a standard editor tab, so most core note functionality should be preserved.
- Any notes opened will continue to work as normal even if the plugin is disabled.

# Contributing

Feel free to make suggestions and issues/PRs, though please consider that I'd like to keep this plugin simple and focused.
