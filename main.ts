import { App, Plugin, PluginSettingTab, Setting, TFile, TextComponent, Notice, WorkspaceLeaf, MarkdownView, FileView, FuzzySuggestModal, Menu, EventRef, View, debounce, normalizePath, AbstractInputSuggest, moment } from 'obsidian';
import { appHasDailyNotesPluginLoaded, getAllDailyNotes, getDailyNote, createDailyNote } from 'obsidian-daily-notes-interface';

// Obsidian fires `leaf-menu` for every tab menu regardless of view type, which is
// the only hook that reaches core sidebar views (Files, Search, Bookmarks...) since
// those never fire `file-menu`. It is missing from the public typings.
declare module 'obsidian' {
	interface Workspace {
		on(name: 'leaf-menu', callback: (menu: Menu, leaf: WorkspaceLeaf) => unknown, ctx?: unknown): EventRef;
	}
}

// Also missing from the typings, and the only hook that reaches tabs other than
// the one on screen: Obsidian skips `onPaneMenu` and `leaf-menu` for hidden
// leaves, but always calls `onTabMenu`.
type TabMenuView = View & { onTabMenu?: (menu: Menu) => void };

type SidebarSide = 'left' | 'right';

interface SidebarTabItem {
	leaf: WorkspaceLeaf;
	side: SidebarSide;
}

interface NoteEntry {
	path: string;
	displayName: string;
	id: string;
	side: SidebarSide;
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
	private manuallyUnpinned: WeakSet<WorkspaceLeaf> = new WeakSet();
	// `file-menu` fires immediately before `leaf-menu` for the same tab menu; this
	// keeps file views from getting both handlers' items.
	private menusHandled: WeakSet<Menu> = new WeakSet();
	private lastSidebarLeaf: WorkspaceLeaf | null = null;
	private debouncedRefreshViews: () => void;

	private getSplit(side: SidebarSide) {
		return side === 'left'
			? this.app.workspace.leftSplit
			: this.app.workspace.rightSplit;
	}

	private getLeaf(side: SidebarSide) {
		return side === 'left'
			? this.app.workspace.getLeftLeaf(false)
			: this.app.workspace.getRightLeaf(false);
	}

	async onload() {
		await this.loadSettings();

		// Initialize debounced refresh function
		this.debouncedRefreshViews = debounce(this.refreshViews.bind(this), 300, true);

		// Add settings tab
		this.addSettingTab(new MobileSidebarNotesSettingTab(this.app, this));

		// Add commands to open each note
		this.addCommands();

		this.patchTabMenu();

		this.addCommand({
			id: 'open-new-right-sidebar-tab',
			name: 'Open new right sidebar tab',
			callback: () => {
				const leaf = this.getLeaf('right');
				if (leaf) void this.app.workspace.revealLeaf(leaf);
			}
		});

		this.addCommand({
			id: 'open-new-left-sidebar-tab',
			name: 'Open new left sidebar tab',
			callback: () => {
				const leaf = this.getLeaf('left');
				if (leaf) void this.app.workspace.revealLeaf(leaf);
			}
		});

		this.addCommand({
			id: 'move-active-tab-to-right-sidebar',
			name: 'Move active tab to right sidebar',
			callback: () => this.moveActiveTabToSidebar('right')
		});

		this.addCommand({
			id: 'move-active-tab-to-left-sidebar',
			name: 'Move active tab to left sidebar',
			callback: () => this.moveActiveTabToSidebar('left')
		});

		this.addCommand({
			id: 'move-active-tab-to-main',
			name: 'Move active tab to main area',
			callback: () => this.moveActiveTabToMain()
		});

		this.addCommand({
			id: 'move-sidebar-tab-to-other-sidebar',
			name: 'Move a sidebar tab to the other sidebar',
			callback: () => this.promptMoveSidebarTab()
		});

		this.addCommand({
			id: 'close-note-tabs-right-sidebar',
			name: 'Close all note tabs in right sidebar',
			callback: () => this.closeSidebarNoteTabs('right')
		});

		this.addCommand({
			id: 'close-note-tabs-left-sidebar',
			name: 'Close all note tabs in left sidebar',
			callback: () => this.closeSidebarNoteTabs('left')
		});

		this.addCommand({
			id: 'deduplicate-sidebar-note-tabs',
			name: 'Deduplicate sidebar note tabs',
			callback: () => this.deduplicateSidebarNoteTabs()
		});

		this.addCommand({
			id: 'open-todays-daily-note-right-sidebar',
			name: "Open today's daily note in right sidebar",
			callback: () => this.openTodaysDailyNote('right')
		});

		this.addCommand({
			id: 'open-todays-daily-note-left-sidebar',
			name: "Open today's daily note in left sidebar",
			callback: () => this.openTodaysDailyNote('left')
		});

		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				if (!this.settings.autoPinTabs) return;
				const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
				if (!leaf) return;
				const root = leaf.getRoot();
				if (root !== this.app.workspace.leftSplit && root !== this.app.workspace.rightSplit) return;
				if (!leaf.getViewState().pinned && !this.manuallyUnpinned.has(leaf)) {
					leaf.setPinned(true);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf && this.isSidebarLeaf(leaf)) {
					this.lastSidebarLeaf = leaf;
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file, source, leaf) => {
				if (!leaf || this.menusHandled.has(menu)) return;

				if (this.isSidebarLeaf(leaf)) {
					this.addMoveMenuItems(menu, leaf);
					return;
				}

				// Main-area tab: only offer the move when this menu belongs to the
				// note actually open in the leaf (skip File Explorer / link menus).
				if (leaf.view.getState()?.file !== file.path) return;

				this.addMoveMenuItems(menu, leaf);
			})
		);

		// Core views (Files, Search, Bookmarks...) get their move actions here, since
		// they have no file and so never reach the `file-menu` handler above.
		this.registerEvent(
			this.app.workspace.on('leaf-menu', (menu: Menu, leaf: WorkspaceLeaf) => {
				if (!leaf || this.menusHandled.has(menu)) return;
				if (leaf.getViewState().type === 'empty') return;

				this.addMoveMenuItems(menu, leaf);
			})
		);

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

	async openFileInSidebar(file: TFile, side: SidebarSide): Promise<WorkspaceLeaf | null> {
		const existingLeaf = this.app.workspace.getLeavesOfType('markdown').find(leaf =>
			leaf.view.getState()?.file === file.path &&
			leaf.getRoot() === this.getSplit(side)
		);

		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return existingLeaf;
		}

		const leaf = this.getLeaf(side);
		if (!leaf) {
			return null;
		}

		await leaf.openFile(file);

		// Auto-pin the tab if setting is enabled
		if (this.settings.autoPinTabs) {
			leaf.setPinned(true);
		}

		await this.app.workspace.revealLeaf(leaf);
		return leaf;
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

			const side = noteEntry.side || 'right';
			const leaf = await this.openFileInSidebar(file, side);
			if (leaf) {
				this.leafMap.set(noteEntry.id, leaf);
			}
		} catch (error) {
			console.error('Error opening note in sidebar:', error);
			new Notice(`Failed to open note: ${error.message}`);
		}
	}

	// A hidden tab's view is still deferred, so its state is the only reliable
	// way to tell a note apart from a core view like Search.
	private isNoteLeaf(leaf: WorkspaceLeaf): boolean {
		return leaf.view instanceof FileView || leaf.getViewState().type === 'markdown';
	}

	private addMoveMenuItems(menu: Menu, leaf: WorkspaceLeaf) {
		this.menusHandled.add(menu);

		const root = leaf.getRoot();
		const inLeft = root === this.app.workspace.leftSplit;
		const inRight = root === this.app.workspace.rightSplit;

		if (inLeft || inRight) {
			// Obsidian only offers this for main-area tabs (`canPin()` is false in a
			// sidebar), so notes in the sidebar need our own toggle.
			if (this.isNoteLeaf(leaf)) {
				const pinned = leaf.getViewState().pinned;
				menu.addItem((item) => {
					item.setTitle(pinned ? 'Unpin' : 'Pin')
						.setIcon('pin')
						.setSection('pane')
						.onClick(() => {
							if (pinned) {
								this.manuallyUnpinned.add(leaf);
							} else {
								this.manuallyUnpinned.delete(leaf);
							}
							leaf.setPinned(!pinned);
						});
				});
			}

			menu.addItem((item) => {
				item.setTitle('Move to main area')
					.setIcon('gallery-vertical')
					.setSection('pane')
					.onClick(() => this.moveLeaf(leaf, 'main'));
			});

			const otherSide: SidebarSide = inLeft ? 'right' : 'left';
			menu.addItem((item) => {
				item.setTitle(`Move to ${otherSide} sidebar`)
					.setIcon(otherSide === 'left' ? 'arrow-left-to-line' : 'arrow-right-to-line')
					.setSection('pane')
					.onClick(() => this.moveLeaf(leaf, otherSide));
			});
			return;
		}

		(['left', 'right'] as SidebarSide[]).forEach((side) => {
			menu.addItem((item) => {
				item.setTitle(`Move to ${side} sidebar`)
					.setIcon(side === 'left' ? 'arrow-left-to-line' : 'arrow-right-to-line')
					.setSection('pane')
					.onClick(() => this.moveLeaf(leaf, side));
			});
		});
	}

	// Long-pressing a tab that is not the one on screen only ever reaches
	// `onTabMenu`, so the move actions have to be added from there. Everything
	// here is written to fail quiet: if the method is gone the patch is skipped,
	// and a throw in our own code can never break Obsidian's menu.
	private patchTabMenu() {
		const proto = View.prototype as TabMenuView;
		const original = proto.onTabMenu;
		if (typeof original !== 'function') return;

		const plugin = this;
		let active = true;
		const patched = function (this: View, menu: Menu) {
			original.call(this, menu);
			if (!active) return;

			try {
				const leaf = this.leaf;
				if (leaf && leaf.getViewState().type !== 'empty') {
					plugin.addMoveMenuItems(menu, leaf);
				}
			} catch (error) {
				console.error('Mobile Sidebar Notes: could not extend the tab menu', error);
			}
		};

		proto.onTabMenu = patched;
		this.register(() => {
			active = false;
			// Only unwind our own patch; another plugin may have wrapped it since.
			if (proto.onTabMenu === patched) proto.onTabMenu = original;
		});
	}

	private ensureSidebarHasTab(side: SidebarSide) {
		const split = this.getSplit(side);
		let hasTab = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.getRoot() === split) hasTab = true;
		});

		if (!hasTab) this.getLeaf(side);
	}

	private getSidebarTabs(): SidebarTabItem[] {
		const items: SidebarTabItem[] = [];

		(['left', 'right'] as SidebarSide[]).forEach((side) => {
			const split = this.getSplit(side);
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.getRoot() !== split) return;
				if (leaf.getViewState().type === 'empty') return;
				items.push({ leaf, side });
			});
		});

		return items;
	}

	// The tab menu can only be extended for the sidebar tab that is currently
	// showing, so this picker is the way to reach the tabs behind it.
	promptMoveSidebarTab() {
		const items = this.getSidebarTabs();
		if (!items.length) {
			new Notice('No sidebar tabs to move');
			return;
		}

		new SidebarTabSuggestModal(this.app, items, (item) => {
			void this.moveLeaf(item.leaf, item.side === 'left' ? 'right' : 'left');
		}).open();
	}

	private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
		const root = leaf.getRoot();
		return root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit;
	}

	private isLeafAttached(leaf: WorkspaceLeaf): boolean {
		let attached = false;
		this.app.workspace.iterateAllLeaves((candidate) => {
			if (candidate === leaf) attached = true;
		});
		return attached;
	}

	// On mobile the command palette steals focus to the main area, so the active
	// leaf is rarely the sidebar note the user is looking at. Fall back to the
	// last sidebar leaf we saw become active.
	private resolveSidebarLeaf(): WorkspaceLeaf | null {
		const active = this.app.workspace.getMostRecentLeaf();
		if (active && this.isSidebarLeaf(active)) {
			return active;
		}
		if (this.lastSidebarLeaf && this.isLeafAttached(this.lastSidebarLeaf) && this.isSidebarLeaf(this.lastSidebarLeaf)) {
			return this.lastSidebarLeaf;
		}
		return null;
	}

	moveActiveTabToSidebar(side: SidebarSide) {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) {
			new Notice('No active tab to move');
			return;
		}
		void this.moveLeaf(leaf, side);
	}

	moveActiveTabToMain() {
		const leaf = this.resolveSidebarLeaf();
		if (!leaf) {
			new Notice('No sidebar tab to move to the main area');
			return;
		}
		void this.moveLeaf(leaf, 'main');
	}

	async moveLeaf(leaf: WorkspaceLeaf, destination: SidebarSide | 'main') {
		const root = leaf.getRoot();
		const inLeft = root === this.app.workspace.leftSplit;
		const inRight = root === this.app.workspace.rightSplit;

		if (destination === 'left' && inLeft) {
			new Notice('Tab is already in the left sidebar');
			return;
		}
		if (destination === 'right' && inRight) {
			new Notice('Tab is already in the right sidebar');
			return;
		}
		if (destination === 'main' && !inLeft && !inRight) {
			new Notice('Tab is already in the main area');
			return;
		}

		const { type, state, group } = leaf.getViewState();
		const ephemeral = leaf.getEphemeralState();

		const target = destination === 'main'
			? this.app.workspace.getLeaf('tab')
			: this.getLeaf(destination);

		if (!target) {
			new Notice('Could not open a destination tab');
			return;
		}

		await target.setViewState({ type, state, group, active: true });
		target.setEphemeralState(ephemeral);
		leaf.detach();

		// Moving the last tab out leaves the sidebar with nothing to interact with,
		// so leave a new tab behind to open a file from.
		if (inLeft || inRight) {
			this.ensureSidebarHasTab(inLeft ? 'left' : 'right');
		}

		// Pinning only means something for note tabs; core views like Search or
		// Files have nothing to be replaced by.
		if (destination !== 'main' && this.settings.autoPinTabs && target.view instanceof FileView) {
			target.setPinned(true);
		}

		await this.app.workspace.revealLeaf(target);
	}

	closeSidebarNoteTabs(side: SidebarSide) {
		const split = this.getSplit(side);
		const leaves = [
			...this.app.workspace.getLeavesOfType('markdown'),
			...this.app.workspace.getLeavesOfType('empty')
		].filter(leaf => leaf.getRoot() === split);

		leaves.forEach(leaf => leaf.detach());

		const label = side === 'left' ? 'left' : 'right';
		new Notice(leaves.length
			? `Closed ${leaves.length} note tab${leaves.length === 1 ? '' : 's'} in the ${label} sidebar`
			: `No note tabs to close in the ${label} sidebar`);
	}

	deduplicateSidebarNoteTabs() {
		let removed = 0;

		(['left', 'right'] as SidebarSide[]).forEach(side => {
			const split = this.getSplit(side);
			const leaves = this.app.workspace.getLeavesOfType('markdown')
				.filter(leaf => leaf.getRoot() === split);

			const seen = new Set<string>();
			leaves.forEach(leaf => {
				const path = leaf.view.getState()?.file as string | undefined;
				if (!path) return;
				if (seen.has(path)) {
					leaf.detach();
					removed++;
				} else {
					seen.add(path);
				}
			});
		});

		new Notice(removed
			? `Removed ${removed} duplicate tab${removed === 1 ? '' : 's'}`
			: 'No duplicate tabs found');
	}

	async openTodaysDailyNote(side: SidebarSide) {
		try {
			if (!appHasDailyNotesPluginLoaded()) {
				new Notice('Enable the core Daily notes plugin to use this command');
				return;
			}

			const today = moment();
			let file: TFile | undefined = getDailyNote(today, getAllDailyNotes());
			if (!file) {
				file = await createDailyNote(today);
			}
			if (!file) {
				new Notice("Could not resolve today's daily note");
				return;
			}

			await this.openFileInSidebar(file, side);
		} catch (error) {
			console.error('Error opening daily note in sidebar:', error);
			new Notice(`Failed to open daily note: ${error.message}`);
		}
	}

	cleanupClosedLeaves() {
		const activeLeaves = this.app.workspace.getLeavesOfType('markdown')
			.filter(leaf =>
				leaf.getRoot() === this.app.workspace.leftSplit ||
				leaf.getRoot() === this.app.workspace.rightSplit
			);

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

		if (this.lastSidebarLeaf && !this.isLeafAttached(this.lastSidebarLeaf)) {
			this.lastSidebarLeaf = null;
		}
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
			const side = noteEntry.side || 'right';
			this.addCommand({
				id: `open-${noteEntry.id}`,
				name: `Open ${title} in ${side} sidebar`,
				callback: () => {
					void this.openNoteInSidebar(noteEntry);
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

class SidebarTabSuggestModal extends FuzzySuggestModal<SidebarTabItem> {
	constructor(app: App, private items: SidebarTabItem[], private onChoose: (item: SidebarTabItem) => void) {
		super(app);
		this.setPlaceholder('Select a sidebar tab to move');
	}

	getItems(): SidebarTabItem[] {
		return this.items;
	}

	getItemText(item: SidebarTabItem): string {
		return `${item.leaf.view.getDisplayText()} (${item.side} sidebar)`;
	}

	onChooseItem(item: SidebarTabItem) {
		this.onChoose(item);
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
		void this.saveCallback();
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

			dismissBtn.addEventListener('click', () => {
				this.plugin.settings.tipDismissed = true;
				this.display();
				void this.plugin.saveSettings();
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
						id: `note-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
						side: 'right'
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
					text.inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							const isValid = this.validatePath(text, text.getValue(), true);
							if (isValid) {
								void this.plugin.openNoteInSidebar(entry);
							}
						}
					});

					// Initial validation
					this.validatePath(text, entry.path, false);

					return text;
				})
				.addDropdown(dropdown => dropdown
					.addOption('right', 'Right')
					.addOption('left', 'Left')
					.setValue(entry.side || 'right')
					.onChange(async (value: SidebarSide) => {
						entry.side = value;
						await this.plugin.saveSettings();
					}))
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
