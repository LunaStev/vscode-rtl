/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { assert } from '../../../../../../base/common/assert.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { ResourceSet } from '../../../../../../base/common/map.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { PromptsConfig } from '../../../../../../platform/prompts/common/config.js';
import { basename, dirname, joinPath } from '../../../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { getPromptFileExtension, getPromptFileLocationsConfigKey, getPromptFileType, PromptsType } from '../../../../../../platform/prompts/common/prompts.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { getExcludes, IFileQuery, ISearchConfiguration, ISearchService, QueryType } from '../../../../../services/search/common/search.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { TPromptsStorage } from '../service/types.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/**
 * Utility class to locate prompt files.
 */
export class PromptFilesLocator extends Disposable {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ISearchService private readonly searchService: ISearchService,
		@IUserDataProfileService private readonly userDataService: IUserDataProfileService,
	) {
		super();
	}

	/**
	 * List all prompt files from the filesystem.
	 *
	 * @returns List of prompt files found in the workspace.
	 */
	public async listFiles(type: PromptsType, storage: TPromptsStorage, token: CancellationToken): Promise<readonly URI[]> {
		if (storage === 'local') {
			return await this.listFilesInLocal(type, token);
		} else {
			return await this.listFilesInUserData(type, token);
		}
	}

	private async listFilesInUserData(type: PromptsType, token: CancellationToken): Promise<readonly URI[]> {
		const files = await this.resolveFilesAtLocation(this.userDataService.currentProfile.promptsHome, token);
		return files.filter(file => getPromptFileType(file) === type);
	}

	public getFilesUpdatedEvent(type: PromptsType): Event<void> {
		const eventEmitter = this._register(new Emitter<void>());
		const key = getPromptFileLocationsConfigKey(type);
		let parentFolders = this.getLocalParentFolders(type).map(folder => folder.parent);
		this._register(this.configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(key)) {
				parentFolders = this.getLocalParentFolders(type).map(folder => folder.parent);
				eventEmitter.fire();
			}
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.affects(this.userDataService.currentProfile.promptsHome)) {
				eventEmitter.fire();
				return;
			}
			if (parentFolders.some(folder => e.affects(folder))) {
				eventEmitter.fire();
				return;
			}
		}));
		this._register(this.fileService.watch(this.userDataService.currentProfile.promptsHome));
		return eventEmitter.event;
	}

	/**
	 * Get all possible unambiguous prompt file source folders based on
	 * the current workspace folder structure.
	 *
	 * This method is currently primarily used by the `> Create Prompt`
	 * command that providers users with the list of destination folders
	 * for a newly created prompt file. Because such a list cannot contain
	 * paths that include `glob pattern` in them, we need to process config
	 * values and try to create a list of clear and unambiguous locations.
	 *
	 * @returns List of possible unambiguous prompt file folders.
	 */
	public getConfigBasedSourceFolders(type: PromptsType): readonly URI[] {
		const configuredLocations = PromptsConfig.promptSourceFolders(this.configService, type);
		const absoluteLocations = this.toAbsoluteLocations(configuredLocations);

		// locations in the settings can contain glob patterns so we need
		// to process them to get "clean" paths; the goal here is to have
		// a list of unambiguous folder paths where prompt files are stored
		const result = new ResourceSet();
		for (let absoluteLocation of absoluteLocations) {
			const baseName = basename(absoluteLocation);

			// if a path ends with a well-known "any file" pattern, remove
			// it so we can get the dirname path of that setting value
			const filePatterns = ['*.md', `*${getPromptFileExtension(type)}`];
			for (const filePattern of filePatterns) {
				if (baseName === filePattern) {
					absoluteLocation = dirname(absoluteLocation);
					continue;
				}
			}

			// likewise, if the pattern ends with single `*` (any file name)
			// remove it to get the dirname path of the setting value
			if (baseName === '*') {
				absoluteLocation = dirname(absoluteLocation);
			}

			// if after replacing the "file name" glob pattern, the path
			// still contains a glob pattern, then ignore the path
			if (isValidGlob(absoluteLocation.path) === true) {
				continue;
			}

			result.add(absoluteLocation);
		}

		return [...result];
	}

	/**
	 * Finds all existent prompt files in the configured local source folders.
	 *
	 * @returns List of prompt files found in the local source folders.
	 */
	private async listFilesInLocal(
		type: PromptsType,
		token: CancellationToken
	): Promise<readonly URI[]> {
		// find all prompt files in the provided locations, then match
		// the found file paths against (possible) glob patterns
		const paths = new ResourceSet();

		for (const { parent, filePattern } of this.getLocalParentFolders(type)) {
			const files = (filePattern === undefined)
				? await this.resolveFilesAtLocation(parent, token) // if the location does not contain a glob pattern, resolve the location directly
				: await this.searchFilesInLocation(parent, filePattern, token);
			for (const file of files) {
				if (getPromptFileType(file) === type) {
					paths.add(file);
				}
			}
			if (token.isCancellationRequested) {
				return [];
			}
		}

		return [...paths];
	}

	private getLocalParentFolders(type: PromptsType): readonly { parent: URI; filePattern?: string }[] {
		const configuredLocations = PromptsConfig.promptSourceFolders(this.configService, type);
		const absoluteLocations = this.toAbsoluteLocations(configuredLocations);
		return absoluteLocations.map(firstNonGlobParentAndPattern);
	}

	/**
	 * Converts locations defined in `settings` to absolute filesystem path URIs.
	 * This conversion is needed because locations in settings can be relative,
	 * hence we need to resolve them based on the current workspace folders.
	 */
	private toAbsoluteLocations(configuredLocations: readonly string[]): readonly URI[] {
		const result = new ResourceSet();
		const { folders } = this.workspaceService.getWorkspace();

		for (const configuredLocation of configuredLocations) {
			if (isAbsolute(configuredLocation)) {
				const remoteAuthority = this.environmentService.remoteAuthority;
				if (remoteAuthority) {
					// if the location is absolute and we are in a remote environment,
					// we need to convert it to a file URI with the remote authority
					result.add(URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: configuredLocation }));
				} else {
					result.add(URI.file(configuredLocation));
				}
			} else {
				for (const workspaceFolder of folders) {
					const absolutePath = joinPath(workspaceFolder.uri, configuredLocation);
					// a sanity check on the expected outcome of the `joinPath()` call
					assert(
						isAbsolute(absolutePath.path),
						`Provided location must be an absolute path, got '${absolutePath.path}'.`,
					);
					result.add(absolutePath);
				}
			}
		}

		return [...result];
	}

	/**
	 * Uses the file service to resolve the provided location and return either the file at the location of files in the directory.
	 */
	private async resolveFilesAtLocation(location: URI, token: CancellationToken): Promise<URI[]> {
		try {
			const info = await this.fileService.resolve(location);
			if (info.isFile) {
				return [info.resource];
			} else if (info.isDirectory && info.children) {
				const result: URI[] = [];
				for (const child of info.children) {
					if (child.isFile) {
						result.push(child.resource);
					}
				}
				return result;
			}
		} catch (error) {
		}
		return [];
	}

	/**
	 * Uses the search service to find all files at the provided location
	 */
	private async searchFilesInLocation(
		folder: URI,
		filePattern: string | undefined,
		token: CancellationToken | undefined
	): Promise<URI[]> {
		const disregardIgnoreFiles = this.configService.getValue<boolean>('explorer.excludeGitIgnore');

		const workspaceRoot = this.workspaceService.getWorkspaceFolder(folder);

		const getExcludePattern = (folder: URI) => getExcludes(this.configService.getValue<ISearchConfiguration>({ resource: folder })) || {};
		const searchOptions: IFileQuery = {
			folderQueries: [{ folder, disregardIgnoreFiles }],
			type: QueryType.File,
			shouldGlobMatchFilePattern: true,
			excludePattern: workspaceRoot ? getExcludePattern(workspaceRoot.uri) : undefined,
			sortByScore: true,
			filePattern
		};

		try {
			const searchResult = await this.searchService.fileSearch(searchOptions, token);
			if (token?.isCancellationRequested) {
				return [];
			}
			return searchResult.results.map(r => r.resource);
		} catch (e) {
			if (!isCancellationError(e)) {
				throw e;
			}
		}
		return [];
	}
}




/**
 * Checks if the provided `pattern` could be a valid glob pattern.
 */
export const isValidGlob = (pattern: string): boolean => {
	let squareBrackets = false;
	let squareBracketsCount = 0;

	let curlyBrackets = false;
	let curlyBracketsCount = 0;

	let previousCharacter: string | undefined;
	for (const char of pattern) {
		// skip all escaped characters
		if (previousCharacter === '\\') {
			previousCharacter = char;
			continue;
		}

		if (char === '*') {
			return true;
		}

		if (char === '?') {
			return true;
		}

		if (char === '[') {
			squareBrackets = true;
			squareBracketsCount++;

			previousCharacter = char;
			continue;
		}

		if (char === ']') {
			squareBrackets = true;
			squareBracketsCount--;
			previousCharacter = char;
			continue;
		}

		if (char === '{') {
			curlyBrackets = true;
			curlyBracketsCount++;
			continue;
		}

		if (char === '}') {
			curlyBrackets = true;
			curlyBracketsCount--;
			previousCharacter = char;
			continue;
		}

		previousCharacter = char;
	}

	// if square brackets exist and are in pairs, this is a `valid glob`
	if (squareBrackets && (squareBracketsCount === 0)) {
		return true;
	}

	// if curly brackets exist and are in pairs, this is a `valid glob`
	if (curlyBrackets && (curlyBracketsCount === 0)) {
		return true;
	}

	return false;
};

/**
 * Finds the first parent of the provided location that does not contain a `glob pattern`.
 *
 * Asumes that the location that is provided has a valid path (is abstract)
 *
 * ## Examples
 *
 * ```typescript
 * assert.strictDeepEqual(
 *     firstNonGlobParentAndPattern(URI.file('/home/user/{folder1,folder2}/file.md')).path,
 *     { parent: URI.file('/home/user'), filePattern: '{folder1,folder2}/file.md' },
 *     'Must find correct non-glob parent dirname.',
 * );
 * ```
 */
const firstNonGlobParentAndPattern = (
	location: URI
): { parent: URI; filePattern?: string } => {
	const segments = location.path.split('/');
	let i = 0;
	while (i < segments.length && isValidGlob(segments[i]) === false) {
		i++;
	}
	if (i === segments.length) {
		// the path does not contain a glob pattern, so we can
		// just find all prompt files in the provided location
		return { parent: location };
	}
	const parent = location.with({ path: segments.slice(0, i).join('/') });
	if (i === segments.length - 1 && segments[i] === '*' || segments[i] === ``) {
		return { parent };
	}

	// the path contains a glob pattern, so we search in last folder that does not contain a glob pattern
	return {
		parent,
		filePattern: segments.slice(i).join('/')
	};
};




