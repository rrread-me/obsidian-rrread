import { App, Notice, Plugin, PluginSettingTab, Setting, DataAdapter, Vault, normalizePath } from 'obsidian';
import * as zip from "@zip.js/zip.js";
const baseUrl = 'http://127.0.0.1:8000';

interface RrreadSettings {
	api_key: string;
	rrreadDir: string;
	authorized: boolean;
	syncing: boolean;
	lastSync: number;
}

const DEFAULT_SETTINGS: RrreadSettings = {
	api_key: Math.random().toString(36).substring(2),
	rrreadDir: 'rrread',
	authorized: false,
	syncing: false,
	lastSync: 0
};

export default class Rrread extends Plugin {
	settings: RrreadSettings;
	fs: DataAdapter;
	vault: Vault;
	scheduleInterval: null | number = null;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RrreadSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is di4bled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	async authorizeRrread() {
		const api_key = this.settings.api_key;
		window.open(`${baseUrl}/obsidian/authorize/?api_key=${api_key}`, '_blank');
		this.settings.authorized = true;
		await this.saveSettings();
	}

	async syncRrread() {
		new Notice('Syncing Rrread...');
		const api_key = this.settings.api_key;
		let response;
		try {
			response = await fetch(`${baseUrl}/api/obsidian/sync/?api_key=${api_key}`);
		} catch (error) {
			console.log('rrread plugin: sync fetch failed: ', error);
		}
		if (response && response.ok) {
			new Notice('Syncing rrread data');
			let data = await response.json();
			while (['started', 'running', 'done'].includes(data.status)) {
				 if (['started', 'running'].includes(data.status)) {
					console.log('Still running', data);
					await new Promise(r => setTimeout(r, 10000));
					response = await fetch(`${baseUrl}/api/obsidian/sync/?api_key=${api_key}`);
					data = await response.json();
				} else if (data.status === 'done') {
					new Notice('Syncing rrread data completed');
					console.log('Syncing rrread data completed', data);
					await this.downloadZip();
					this.settings.lastSync = data.last_sync;
					await this.saveSettings();
					break;
				} else {
					console.log('rrread plugin: sync fetch failed: ', data);
					new Notice('Syncing rrread data failed');
					console.log('Syncing rrread data failed')
					break;
				}
			}
		} else {
			console.log('rrread: bad response in syncRrread: ', response);
		}
	}

	async downloadZip() {
		let response, blob;
		try {
			response = await fetch(`${baseUrl}/api/obsidian/download/?api_key=${this.settings.api_key}`);
		} catch (error) {
			console.log("rrread: fetch failed from download url: ", error);
		}
		if (response && response.ok) {
			blob = await response.blob();
		} else {
			console.log('rrread: bad response in downloadZip: ', response);
			return
		}
		this.fs = this.app.vault.adapter;
		const blobReader = new zip.BlobReader(blob);
		const zipReader = new zip.ZipReader(blobReader);
		const entries = await zipReader.getEntries();
		new Notice("Saving files...");
		if (entries.length) {
			for (const entry of entries) {
				const processedFileName = normalizePath(entry.filename.replace(/^rrread/, this.settings.rrreadDir));
				try {
					// ensure the directory exists
					let dirPath = processedFileName.replace(/\/*$/, '').replace(/^(.+)\/[^\/]*?$/, '$1');
					const exists = await this.fs.exists(dirPath);
					if (!exists) {
						await this.fs.mkdir(dirPath);
					}
					// write the actual files
					const contents = await entry.getData(new zip.TextWriter());
					let contentToSave = contents;

					let originalName = processedFileName;
					if (await this.fs.exists(originalName)) {
						// if the file already exists we need to append content to existing one
						const existingContent = await this.fs.read(originalName);
						contentToSave = existingContent + contents;
					}
					await this.fs.write(originalName, contentToSave);
				} catch (e) {
					console.log(`rrread: error writing ${processedFileName}:`, e);
					new Notice(`rrread: error writing ${processedFileName}:`, e);
				}
			}
		}
		await zipReader.close();
		await fetch(`${baseUrl}/api/obsidian/download-success/?api_key=${this.settings.api_key}`);
		new Notice("rrread sync completed");
	}
}

class RrreadSettingTab extends PluginSettingTab {
	plugin: Rrread;

	constructor(app: App, plugin: Rrread) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h1', { text: 'rrread' });
		containerEl.createEl('p', { text: 'Created by ' }).createEl('a', { text: 'rrread', href: 'https://rrread.me' });
		containerEl.createEl('h2', { text: 'Settings' });

		if (!this.plugin.settings.authorized) {
			new Setting(containerEl)
				.setName('Connect Obsidian to rrread')
				.setDesc('Authorize rrread to sync your highlights from Raindrop, Kindle, Instapaper and more. Requires a rrread account.')
				.addButton(button => button
					.setButtonText('Authorize')
					.onClick(async () => {
						await this.plugin.authorizeRrread();
						this.display();
					}));
		} else {
			new Setting(containerEl)
				.setName('Sync rrread')
				.setDesc('Sync your highlights with rrread. On first sync, a new folder will be created.')
				.addButton(button => button
					.setButtonText('Sync')
					.setTooltip('Once the sync begins, you can close this plugin page')
					.onClick(async () => {
						if (this.plugin.settings.syncing) {
							new Notice("rrread sync already in running.");
						} else {
							this.plugin.settings.syncing = true;
							await this.plugin.saveSettings();
							button.setButtonText("Syncing...");
							this.plugin.syncRrread();
							this.plugin.settings.syncing = false;
							await this.plugin.saveSettings();
						}
					}));

			new Setting(containerEl)
				.setName('Customize formatting options')
				.setDesc('You can customize which items export to Obsidian and how they appear.')
				.addButton(button => button
					.setButtonText('Customize')
					.onClick(() => {
						window.open(`${baseUrl}/home/?dialog=obsidian`);
					}
					));

			new Setting(containerEl)
				.setName('Customize base folder')
				.setDesc("By default, the plugin will save all your highlights into a folder named rrread")
				.addText(text => text
					.setPlaceholder('Defaults to: rrread')
					.setValue(this.plugin.settings.rrreadDir)
					.onChange(async (value) => {
						this.plugin.settings.rrreadDir = normalizePath(value || "rrread");
					await this.plugin.saveSettings();
					}));
		}

		const help = containerEl.createEl('p',);
		help.innerHTML = "Need help? Check our <a href='http://rrread.me/faq/'>FAQs</a> or email us at <a href='mailto:help@rrread.me'>help@rrread.me</a>.";
	}
}
