import { App, Plugin, PluginSettingTab, Setting, TFile, TextComponent, Notice, WorkspaceLeaf, debounce, normalizePath, AbstractInputSuggest } from 'obsidian';

interface NoteEntry {
	path: string;
	displayName: string;
	id: string;
}

interface MobileSidebarNotesSettings {
	noteEntries: NoteEntry[];
	tipDismissed: boolean;
	autoPinTabs: boolean;
}

const DEFAULT_SETTINGS: MobileSidebarNotesSettings = {
	noteEntries: [],
	tipDismissed: false,
	autoPinTabs: true
}


export default class MobileSidebarNotesPlugin extends Plugin {
	settings: MobileSidebarNotesSettings;
	private leafMap: Map<string, WorkspaceLeaf> = new Map();
	private debouncedRefreshViews: () => void;

	async onload() {
		await this.loadSettings();

		// Initialize debounced refresh function
		this.debouncedRefreshViews = debounce(this.refreshViews.bind(this), 300, true);

		// Add settings tab
		this.addSettingTab(new MobileSidebarNotesSettingTab(this.app, this));

		// Add commands to open each note
		this.addCommands();

		// Add command to open new empty tab
		this.addCommand({
			id: 'open-new-sidebar-tab',
			name: 'Open new sidebar tab',
			callback: () => {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					this.app.workspace.revealLeaf(leaf);
				}
			}
		});

		// Listen for leaf changes to clean up our leaf map
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.cleanupClosedLeaves();
			})
		);

	}

	onunload() {
		// Clean up leaf references
		this.leafMap.clear();
	}

	async openNoteInSidebar(noteEntry: NoteEntry) {
		try {
			if (!noteEntry.path || !noteEntry.path.trim()) {
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(noteEntry.path);
			if (!(file instanceof TFile)) {
				return;
			}

			// Check if this file is already open in the right sidebar
			const leaves = this.app.workspace.getLeavesOfType('markdown');
			const existingLeaf = leaves.find(leaf =>
				leaf.view.getState()?.file === file.path &&
				leaf.getRoot() === this.app.workspace.rightSplit
			);

			if (existingLeaf) {
				this.app.workspace.revealLeaf(existingLeaf);
				this.leafMap.set(noteEntry.id, existingLeaf);
				return;
			}

			// Create a new leaf in the right sidebar
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.openFile(file);
				// Store the leaf reference for this entry
				this.leafMap.set(noteEntry.id, leaf);

				// Auto-pin the tab if setting is enabled
				if (this.settings.autoPinTabs) {
					leaf.setPinned(true);
				}
			}
		} catch (error) {
			console.error('Error opening note in sidebar:', error);
			new Notice(`Failed to open note: ${error.message}`);
		}
	}

	cleanupClosedLeaves() {
		// Remove closed leaves from our tracking map
		const activeLeaves = this.app.workspace.getLeavesOfType('markdown')
			.filter(leaf => leaf.getRoot() === this.app.workspace.rightSplit);

		// Find entries whose leaves no longer exist
		const toRemove: string[] = [];
		this.leafMap.forEach((leaf, id) => {
			if (!activeLeaves.includes(leaf)) {
				toRemove.push(id);
			}
		});

		// Remove stale references
		toRemove.forEach(id => {
			this.leafMap.delete(id);
		});
	}

	addCommands() {
		this.settings.noteEntries.forEach(noteEntry => {
			// Only register command if path is not empty and file exists
			if (!noteEntry.path || !noteEntry.path.trim()) {
				return;
			}

			// Check if file exists
			const sanitizedPath = normalizePath(noteEntry.path.trim());
			const file = this.app.vault.getAbstractFileByPath(sanitizedPath);
			if (!(file instanceof TFile)) {
				return;
			}

			// Use displayName if provided, otherwise use file path
			const title = noteEntry.displayName.trim() || noteEntry.path || 'Untitled';
			this.addCommand({
				id: `open-${noteEntry.id}`,
				name: `Open ${title} in sidebar`,
				callback: () => {
					this.openNoteInSidebar(noteEntry);
				}
			});
		});
	}


	async refreshViews() {
		// Close existing sidebar notes
		this.leafMap.forEach((leaf) => {
			if (leaf) {
				leaf.detach();
			}
		});
		this.leafMap.clear();

		// Re-add commands and open notes
		this.addCommands();

		// Open notes sequentially to avoid race conditions
		for (const entry of this.settings.noteEntries) {
			await this.openNoteInSidebar(entry);
		}
	}

	async loadSettings() {
		try {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		} catch (error) {
			console.error('Failed to load settings:', error);
			this.settings = DEFAULT_SETTINGS;
			new Notice('Failed to load settings, using defaults');
		}
	}

	async saveSettings() {
		try {
			await this.saveData(this.settings);
			this.debouncedRefreshViews();
		} catch (error) {
			console.error('Failed to save settings:', error);
			new Notice('Failed to save settings');
		}
	}
}

class NotePathSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, private textComponent: TextComponent, private entry: NoteEntry, private saveCallback: () => Promise<void>) {
		super(app, textComponent.inputEl);
	}

	getSuggestions(inputStr: string): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		const lowerInput = inputStr.toLowerCase();
		return files
			.filter(file => file.path.toLowerCase().includes(lowerInput))
			.slice(0, 5);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.entry.path = file.path;
		this.textComponent.setValue(file.path);
		this.saveCallback();
	}
}

class MobileSidebarNotesSettingTab extends PluginSettingTab {
	plugin: MobileSidebarNotesPlugin;

	constructor(app: App, plugin: MobileSidebarNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Auto-pin tabs setting
		new Setting(containerEl)
			.setName('Auto-pin tabs')
			.setDesc('Automatically pin notes opened in the sidebar to open links in new tabs')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoPinTabs)
				.onChange(async (value) => {
					this.plugin.settings.autoPinTabs = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Commands')
			.setHeading();

		// Show tip if not dismissed
		if (!this.plugin.settings.tipDismissed) {
			const tipEl = containerEl.createDiv({ cls: 'setting-item-description mobile-sidebar-tip' });

			const tipContent = tipEl.createDiv();
			tipContent.createSpan({ text: '📌 ' });
			tipContent.createEl('strong', { text: 'Tip:' });
			tipContent.createSpan({ text: ' To close/pin/rename/manage sidebar tabs, press and hold the note title in the sidebar source dropdown.' });

			const dismissBtn = tipEl.createEl('button', {
				cls: 'mobile-sidebar-tip-dismiss-btn',
				text: '×'
			});
			dismissBtn.title = 'Dismiss tip';

			dismissBtn.addEventListener('click', async () => {
				this.plugin.settings.tipDismissed = true;
				await this.plugin.saveSettings();
				this.display();
			});

		}

		// Add new note entry button
		new Setting(containerEl)
			.setName('Add specific notes as a command')
			.setDesc('Registers a command to open a specific note in the sidebar in the command palette or as a hotkey.')
			.addButton(button => button
				.setButtonText('Add command')
				.onClick(async () => {
					const newEntry: NoteEntry = {
						path: '',
						displayName: '',
						id: `note-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
					};
					this.plugin.settings.noteEntries.push(newEntry);
					await this.plugin.saveSettings();
					this.display();
				}));

		// Display existing note entries
		this.plugin.settings.noteEntries.forEach((entry, index) => {
			const setting = new Setting(containerEl)
				.setName(`Note ${index + 1}`)
				.addText(text => text
					.setPlaceholder('Title (in command)')
					.setValue(entry.displayName)
					.onChange(async (value) => {
						entry.displayName = value;
						await this.plugin.saveSettings();
					}))
				.addText(text => {
					text.setPlaceholder('Note path (e.g., folder/note.md)')
						.setValue(entry.path)
						.onChange(async (value) => {
							entry.path = value;
							this.validatePath(text, value, false); // Don't show toast on change
							await this.plugin.saveSettings();
						});

					// Add autocomplete functionality
					new NotePathSuggest(this.app, text, entry, async () => {
						await this.plugin.saveSettings();
						this.validatePath(text, entry.path, false);
					});

					// Handle Enter key to open note
					text.inputEl.addEventListener('keydown', async (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							const isValid = this.validatePath(text, text.getValue(), true);
							if (isValid) {
								await this.plugin.openNoteInSidebar(entry);
							}
						}
					});

					// Initial validation
					this.validatePath(text, entry.path, false);

					return text;
				})
				.addButton(button => button
					.setButtonText('Remove')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.noteEntries.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));

			setting.settingEl.addClass('mobile-sidebar-setting-item');
		});
	}

	validatePath(textComponent: TextComponent, path: string, showToast = true) {
		const inputEl = textComponent.inputEl;
		inputEl.removeClass('valid', 'invalid');

		if (!path.trim()) {
			inputEl.addClass('mobile-sidebar-path-input', 'invalid');
			inputEl.title = 'Path is required to register command';
			if (showToast) {
				new Notice('Please specify a note path');
			}
			return false;
		}

		// Sanitize path
		const sanitizedPath = normalizePath(path.trim());
		const file = this.app.vault.getAbstractFileByPath(sanitizedPath);

		if (file instanceof TFile) {
			inputEl.addClass('mobile-sidebar-path-input', 'valid');
			inputEl.title = 'Valid note path';
			return true;
		} else {
			inputEl.addClass('mobile-sidebar-path-input', 'invalid');
			inputEl.title = 'Note not found - command will not be registered';
			if (showToast) {
				new Notice(`Note not found: ${path}`);
			}
			return false;
		}
	}

}
