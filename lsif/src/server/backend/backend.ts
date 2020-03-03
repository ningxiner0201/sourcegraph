import * as sqliteModels from '../../shared/models/sqlite'
import * as lsp from 'vscode-languageserver-protocol'
import * as settings from '../settings'
import * as pgModels from '../../shared/models/pg'
import { addTags, logSpan, TracingContext } from '../../shared/tracing'
import { ConnectionCache, DocumentCache, ResultChunkCache } from './cache'
import { Database, sortMonikers, InternalLocation } from './database'
import { dbFilename } from '../../shared/paths'
import { isEqual, uniqWith } from 'lodash'
import { mustGet } from '../../shared/maps'
import { DumpManager } from '../../shared/store/dumps'
import { DependencyManager } from '../../shared/store/dependencies'
import { isDefined } from '../../shared/util'

/**
 * Context describing the current request for paginated results.
 */
export interface ReferencePaginationContext {
    /**
     * The maximum number of remote dumps to search.
     */
    limit: number

    /**
     * Context describing the previous page of results.
     */
    cursor?: ReferencePaginationCursor
}

/**
 * Reference pagination happens in two distinct phases:
 *
 *   (1) open a slice of dumps for the same repositories, and
 *   (2) open a slice of dumps for other repositories.
 */
export type ReferencePaginationPhase = 'same-repo' | 'remote-repo'

/**
 * Context describing the previous page of results.
 */
export interface ReferencePaginationCursor {
    /**
     * The identifier of the dump that contains the target range.
     */
    dumpId: number

    /**
     * The scheme of the moniker that has remote results.
     */
    scheme: string

    /**
     * The identifier of the moniker that has remote results.
     */
    identifier: string

    /**
     * The name of the package that has remote results.
     */
    name: string

    /**
     * The version of the package that has remote results.
     */
    version: string | null

    /**
     * The phase of the pagination.
     */
    phase: ReferencePaginationPhase

    /**
     * The number of remote dumps to skip.
     */
    offset: number
}

/**
 * Converts a file in the repository to the corresponding file in the
 * database.
 *
 * @param root The root of all files in the dump.
 * @param path The path within the dump.
 */
const pathToDatabase = (root: string, path: string): string => (path.startsWith(root) ? path.slice(root.length) : path)

/**
 * Converts a location in a dump to the corresponding location in the repository.
 *
 * @param root The root of all files in the dump.
 * @param location The original location.
 */
const locationFromDatabase = (root: string, { dump, path, range }: InternalLocation): InternalLocation => ({
    dump,
    path: `${root}${path}`,
    range,
})

/**
 * A wrapper around code intelligence operations.
 */
export class Backend {
    private connectionCache = new ConnectionCache(settings.CONNECTION_CACHE_CAPACITY)
    private documentCache = new DocumentCache(settings.DOCUMENT_CACHE_CAPACITY)
    private resultChunkCache = new ResultChunkCache(settings.RESULT_CHUNK_CACHE_CAPACITY)

    /**
     * Create a new `Backend`.
     *
     * @param storageRoot The path where SQLite databases are stored.
     * @param dumpManager The dumps manager instance.
     * @param dependencyManager The dependency manager instance.
     * @param frontendUrl The url of the frontend internal API.
     */
    constructor(
        private storageRoot: string,
        private dumpManager: DumpManager,
        private dependencyManager: DependencyManager,
        private frontendUrl: string
    ) {}

    /**
     * Determine if data exists for a particular document.
     *
     * @param repositoryId The repository identifier.
     * @param commit The commit.
     * @param path The path of the document.
     * @param ctx The tracing context.
     */
    public async exists(
        repositoryId: number,
        commit: string,
        path: string,
        ctx: TracingContext = {}
    ): Promise<pgModels.LsifDump[]> {
        return (await this.findClosestDatabases(repositoryId, commit, path, ctx)).map(({ dump }) => dump)
    }

    /**
     * Return the location for the symbol at the given position. Returns undefined if no dump can
     * be loaded to answer this query.
     *
     * @param repositoryId The repository identifier.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param dumpId The identifier of the dump to load. If not supplied, the closest dump will be used.
     * @param ctx The tracing context.
     */
    public async definitions(
        repositoryId: number,
        commit: string,
        path: string,
        position: lsp.Position,
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<InternalLocation[] | undefined> {
        const result = await this.internalDefinitions(repositoryId, commit, path, position, dumpId, ctx)
        if (result === undefined) {
            return undefined
        }

        return result.locations
    }

    /**
     * Return a list of locations which reference the symbol at the given position. Returns
     * undefined if no dump can be loaded to answer this query.
     *
     * @param repositoryId The repository identifier.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param paginationContext Context describing the current request for paginated results.
     * @param dumpId The identifier of the dump to load. If not supplied, the closest dump will be used.
     * @param ctx The tracing context.
     */
    public async references(
        repositoryId: number,
        commit: string,
        path: string,
        position: lsp.Position,
        paginationContext: ReferencePaginationContext = { limit: 10 },
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; newCursor?: ReferencePaginationCursor } | undefined> {
        return this.internalReferences(repositoryId, commit, path, position, paginationContext, dumpId, ctx)
    }

    /**
     * Return the hover content for the symbol at the given position. Returns undefined if no dump can
     * be loaded to answer this query.
     *
     * @param repositoryId The repository identifier.
     * @param commit The commit.
     * @param path The path of the document to which the position belongs.
     * @param position The current hover position.
     * @param dumpId The identifier of the dump to load. If not supplied, the closest dump will be used.
     * @param ctx The tracing context.
     */
    public async hover(
        repositoryId: number,
        commit: string,
        path: string,
        position: lsp.Position,
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<{ text: string; range: lsp.Range } | null | undefined> {
        const closestDatabaseAndDump = await this.closestDatabase(repositoryId, commit, path, dumpId, ctx)
        if (!closestDatabaseAndDump) {
            if (ctx.logger) {
                ctx.logger.warn('No database could be loaded', { repositoryId, commit, path })
            }

            return undefined
        }
        const { database, dump, ctx: newCtx } = closestDatabaseAndDump

        // Try to find hover in the same dump
        const hover = await database.hover(pathToDatabase(dump.root, path), position, newCtx)
        if (hover !== null) {
            return hover
        }

        // If we don't have a local hover, lookup the definitions of the
        // range and read the hover data from the remote database. This
        // can happen when the indexer only gives a moniker but does not
        // give hover data for externally defined symbols.

        const result = await this.internalDefinitions(repositoryId, commit, path, position, dumpId, ctx)
        if (result === undefined || result.locations.length === 0) {
            return null
        }

        return this.createDatabase(result.locations[0].dump).hover(
            pathToDatabase(result.locations[0].dump.root, result.locations[0].path),
            result.locations[0].range.start,
            newCtx
        )
    }

    private async internalDefinitions(
        repositoryId: number,
        commit: string,
        path: string,
        position: lsp.Position,
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<{ dump: pgModels.LsifDump; locations: InternalLocation[] } | undefined> {
        const closestDatabaseAndDump = await this.closestDatabase(repositoryId, commit, path, dumpId, ctx)
        if (!closestDatabaseAndDump) {
            if (ctx.logger) {
                ctx.logger.warn('No database could be loaded', { repositoryId, commit, path })
            }

            return undefined
        }
        const { database, dump, ctx: newCtx } = closestDatabaseAndDump

        // Construct path within dump
        const pathInDb = pathToDatabase(dump.root, path)

        // Try to find definitions in the same dump
        const dbDefinitions = await database.definitions(pathInDb, position, newCtx)
        const definitions = dbDefinitions.map(loc => locationFromDatabase(dump.root, loc))
        if (definitions.length > 0) {
            return { dump, locations: definitions }
        }

        // Try to find definitions in other dumps
        const { document, ranges } = await database.getRangeByPosition(pathInDb, position, ctx)
        if (!document || ranges.length === 0) {
            return { dump, locations: [] }
        }

        // First, we find the monikers for each range, from innermost to
        // outermost, such that the set of monikers for reach range is sorted by
        // priority. Then, we perform a search for each moniker, in sequence,
        // until valid results are found.
        for (const range of ranges) {
            const monikers = sortMonikers(
                Array.from(range.monikerIds).map(id => mustGet(document.monikers, id, 'moniker'))
            )

            for (const moniker of monikers) {
                if (moniker.kind === 'import') {
                    // This symbol was imported from another database. See if we have
                    // an remote definition for it.

                    const remoteDefinitions = await this.lookupMoniker(
                        document,
                        moniker,
                        sqliteModels.DefinitionModel,
                        {},
                        ctx
                    )
                    if (remoteDefinitions.length > 0) {
                        return { dump, locations: remoteDefinitions }
                    }
                } else {
                    // This symbol was not imported from another database. We search the definitions
                    // table of our own database in case there was a definition that wasn't properly
                    // attached to a result set but did have the correct monikers attached.

                    const { locations: monikerResults } = await database.monikerResults(
                        sqliteModels.DefinitionModel,
                        moniker,
                        {},
                        ctx
                    )
                    const localDefinitions = monikerResults.map(loc => locationFromDatabase(dump.root, loc))
                    if (localDefinitions.length > 0) {
                        return { dump, locations: localDefinitions }
                    }
                }
            }
        }
        return { dump, locations: [] }
    }

    private async internalReferences(
        repositoryId: number,
        commit: string,
        path: string,
        position: lsp.Position,
        paginationContext: ReferencePaginationContext = { limit: 10 },
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<
        { dump: pgModels.LsifDump; locations: InternalLocation[]; newCursor?: ReferencePaginationCursor } | undefined
    > {
        if (paginationContext.cursor) {
            return this.handleReferencesNextPage(
                repositoryId,
                commit,
                paginationContext.limit,
                paginationContext.cursor,
                ctx
            )
        }

        const closestDatabaseAndDump = await this.closestDatabase(repositoryId, commit, path, dumpId, ctx)
        if (!closestDatabaseAndDump) {
            if (ctx.logger) {
                ctx.logger.warn('No database could be loaded', { repositoryId, commit, path })
            }

            return undefined
        }
        const { database, dump, ctx: newCtx } = closestDatabaseAndDump

        // Construct path within dump
        const pathInDb = pathToDatabase(dump.root, path)

        // Try to find references in the same dump
        const dbReferences = await database.references(pathInDb, position, newCtx)
        let locations = dbReferences.map(loc => locationFromDatabase(dump.root, loc))

        // Next, we do a moniker search in two stages, described below. We process the
        // monikers for each range sequentially in order of priority for each stage, such
        // that import monikers, if any exist, will be processed first.

        const { document, ranges } = await database.getRangeByPosition(pathInDb, position, ctx)
        if (!document || ranges.length === 0) {
            return { dump, locations: [] }
        }

        for (const range of ranges) {
            const monikers = sortMonikers(
                Array.from(range.monikerIds).map(id => mustGet(document.monikers, id, 'monikers'))
            )

            // Next, we search the references table of our own database - this search is necessary,
            // but may be un-intuitive, but remember that a 'Find References' operation on a reference
            // should also return references to the definition. These are not necessarily fully linked
            // in the LSIF data.

            for (const moniker of monikers) {
                const { locations: monikerResults } = await database.monikerResults(
                    sqliteModels.ReferenceModel,
                    moniker,
                    {},
                    ctx
                )
                locations = locations.concat(monikerResults.map(loc => locationFromDatabase(dump.root, loc)))
            }

            // Next, we perform a remote search for uses of each nonlocal moniker. We stop processing
            // after the first moniker for which we received results. As we process monikers in an order
            // that considers moniker schemes, the first one to get results should be the most desirable.

            for (const moniker of monikers) {
                if (moniker.kind === 'import') {
                    // Get locations in the defining package
                    const monikerLocations = await this.lookupMoniker(
                        document,
                        moniker,
                        sqliteModels.ReferenceModel,
                        {},
                        ctx
                    )
                    locations = locations.concat(monikerLocations)
                }

                const packageInformation = this.lookupPackageInformation(document, moniker, ctx)
                if (!packageInformation) {
                    continue
                }

                // Build pagination cursor that will start scanning results from
                // the beginning of the set of results: first, scan dumps of the same
                // repository, then scan dumps from remote repositories.

                const cursor: ReferencePaginationCursor = {
                    dumpId: dump.id,
                    scheme: moniker.scheme,
                    identifier: moniker.identifier,
                    name: packageInformation.name,
                    version: packageInformation.version,
                    phase: 'same-repo',
                    offset: 0,
                }

                const { locations: remoteLocations, newCursor } = await this.handleReferencePaginationCursor(
                    repositoryId,
                    commit,
                    paginationContext.limit,
                    cursor,
                    ctx
                )

                return {
                    dump,
                    // TODO - determine source of duplication
                    locations: uniqWith(locations.concat(remoteLocations), isEqual),
                    newCursor,
                }
            }
        }

        // TODO - determine source of duplication
        return { dump, locations: uniqWith(locations, isEqual) }
    }

    /**
     * Handle a references request given a non-empty pagination cursor.
     *
     * @param repositoryId The repository identifier.
     * @param commit The commit.
     * @param limit The pagination limit.
     * @param cursor The pagination cursor.
     * @param ctx The tracing context.
     */
    private async handleReferencesNextPage(
        repositoryId: number,
        commit: string,
        limit: number,
        cursor: ReferencePaginationCursor,
        ctx: TracingContext = {}
    ): Promise<
        { dump: pgModels.LsifDump; locations: InternalLocation[]; newCursor?: ReferencePaginationCursor } | undefined
    > {
        const dump = await this.dumpManager.getDumpById(cursor.dumpId)
        if (dump === undefined) {
            return undefined
        }

        // Continue from previous page
        const results = await this.handleReferencePaginationCursor(repositoryId, commit, limit, cursor, ctx)
        if (results !== undefined) {
            return { dump, ...results }
        }

        // No results remaining
        return { dump, locations: [] }
    }

    /**
     * Retrieve the package information from associated with the given moniker.
     *
     * @param document The document containing an instance of the moniker.
     * @param moniker The target moniker.
     * @param ctx The tracing context.
     */
    private lookupPackageInformation(
        document: sqliteModels.DocumentData,
        moniker: sqliteModels.MonikerData,
        ctx: TracingContext = {}
    ): sqliteModels.PackageInformationData | undefined {
        if (!moniker.packageInformationId) {
            return undefined
        }

        const packageInformation = document.packageInformation.get(moniker.packageInformationId)
        if (!packageInformation) {
            return undefined
        }

        logSpan(ctx, 'package_information', {
            moniker,
            packageInformation,
        })

        return packageInformation
    }

    /**
     * Find the locations attached to the target moniker outside of the current database. If
     * the moniker has attached package information, then Postgres is queried for the target
     * package. That database is opened, and its definitions table is queried for the target
     * moniker.
     *
     * @param document The document containing the definition.
     * @param moniker The target moniker.
     * @param model The target model.
     * @param pagination A limit and offset to use for the query.
     * @param ctx The tracing context.
     */
    private async lookupMoniker(
        document: sqliteModels.DocumentData,
        moniker: sqliteModels.MonikerData,
        model: typeof sqliteModels.DefinitionModel | typeof sqliteModels.ReferenceModel,
        pagination: { skip?: number; take?: number },
        ctx: TracingContext = {}
    ): Promise<InternalLocation[]> {
        const packageInformation = this.lookupPackageInformation(document, moniker, ctx)
        if (!packageInformation) {
            return []
        }

        const packageEntity = await this.dependencyManager.getPackage(
            moniker.scheme,
            packageInformation.name,
            packageInformation.version
        )
        if (!packageEntity) {
            return []
        }

        logSpan(ctx, 'package_entity', {
            moniker,
            packageInformation,
            packageRepositoryId: packageEntity.dump.repositoryId,
            packageCommit: packageEntity.dump.commit,
        })

        const { locations: monikerResults } = await this.createDatabase(packageEntity.dump).monikerResults(
            model,
            moniker,
            pagination,
            ctx
        )
        return monikerResults.map(loc => locationFromDatabase(packageEntity.dump.root, loc))
    }

    /**
     * Perform a remote reference lookup on the dumps of the same repository, then on dumps of
     * other repositories. The offset into the set of results (as well as the target set of dumps)
     * depends on the exact values of the pagination cursor. If there are any locations in the result
     * set, this method returns the new cursor. This method return undefined if there are no remaining
     * results for the same repository.
     *
     * @param repositoryId The repository identifier.
     * @param commit The target commit.
     * @param limit The maximum number of dumps to open.
     * @param cursor The pagination cursor.
     * @param ctx The tracing context.
     */
    private async handleReferencePaginationCursor(
        repositoryId: number,
        commit: string,
        limit: number,
        cursor: ReferencePaginationCursor,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; newCursor?: ReferencePaginationCursor }> {
        switch (cursor.phase) {
            case 'same-repo': {
                const { locations, newCursor: nextSameRepoCursor } = await this.performSameRepositoryRemoteReferences(
                    repositoryId,
                    commit,
                    limit,
                    cursor,
                    ctx
                )

                // If we don't have a valid new cursor, see if we can move on to the next phase.
                // Only construct a cursor that will be valid on a subsequent request. We don't
                // want the situation where there are no uses of a symbol outside of the current
                // repository and we give a "load more" option that  yields no additional results.

                let newCursor = nextSameRepoCursor
                if (!nextSameRepoCursor && (await this.hasRemoteReferences(repositoryId, cursor))) {
                    newCursor = {
                        ...cursor,
                        phase: 'remote-repo',
                        offset: 0,
                    }
                }

                if (locations.length === 0 && newCursor) {
                    return this.handleReferencePaginationCursor(repositoryId, commit, limit, newCursor, ctx)
                }

                return { locations, newCursor }
            }

            case 'remote-repo': {
                return this.performRemoteReferences(repositoryId, limit, cursor, ctx)
            }
        }
    }

    /**
     * Determine if the moniker and package identified by the pagination cursor has at least one
     * remote repository. containing that definition. We use this to determine if we should move
     * on to the next phase without doing it unconditionally and yielding an empty last page.
     *
     * @param repositoryId The repository identifier.
     * @param cursor The pagination cursor.
     */
    private async hasRemoteReferences(repositoryId: number, cursor: ReferencePaginationCursor): Promise<boolean> {
        const { totalCount: remoteTotalCount } = await this.dependencyManager.getReferences({
            ...cursor,
            repositoryId,
            limit: 1,
            offset: 0,
        })

        return remoteTotalCount > 0
    }

    /**
     * Perform a remote reference lookup on the dumps of the same repository. If there are any
     * locations in the result set, this method returns the new cursor. This method return
     * undefined if there are no remaining results for the same repository.
     *
     * @param repositoryId The repository identifier.
     * @param commit The target commit.
     * @param limit The maximum number of dumps to open.
     * @param cursor The pagination cursor.
     * @param ctx The tracing context.
     */
    private async performSameRepositoryRemoteReferences(
        repositoryId: number,
        commit: string,
        limit: number,
        cursor: ReferencePaginationCursor,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; newCursor?: ReferencePaginationCursor }> {
        const moniker = { scheme: cursor.scheme, identifier: cursor.identifier }
        const packageInformation = { name: cursor.name, version: cursor.version }

        const { locations, totalCount, newOffset } = await this.sameRepositoryRemoteReferences(
            cursor.dumpId,
            repositoryId,
            commit,
            moniker,
            packageInformation,
            limit,
            cursor.offset,
            ctx
        )

        return {
            locations,
            newCursor: newOffset < totalCount ? { ...cursor, phase: 'same-repo', offset: newOffset } : undefined,
        }
    }

    /**
     * Perform a remote reference lookup on dumps of remote repositories. If there are any
     * locations in the result set, this method returns the new cursor. This method return
     * undefined if there are no remaining results for the same repository.
     *
     * @param repositoryId The repository identifier.
     * @param limit The maximum number of dumps to open.
     * @param cursor The pagination cursor.
     * @param ctx The tracing context.
     */
    private async performRemoteReferences(
        repositoryId: number,
        limit: number,
        cursor: ReferencePaginationCursor,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; newCursor?: ReferencePaginationCursor }> {
        const moniker = { scheme: cursor.scheme, identifier: cursor.identifier }
        const packageInformation = { name: cursor.name, version: cursor.version }

        const { locations, totalCount, newOffset } = await this.remoteReferences(
            cursor.dumpId,
            repositoryId,
            moniker,
            packageInformation,
            limit,
            cursor.offset,
            ctx
        )

        return {
            locations,
            newCursor: newOffset < totalCount ? { ...cursor, phase: 'remote-repo', offset: newOffset } : undefined,
        }
    }

    /**
     * Find the references of the target moniker outside of the current repository. If the moniker
     * has attached package information, then Postgres is queried for the packages that require
     * this particular moniker identifier. These dumps are opened, and their references tables are
     * queried for the target moniker.
     *
     * @param dumpId The ID of the dump for which this database answers queries.
     * @param repositoryId The repository identifier for which this database answers queries.
     * @param moniker The target moniker.
     * @param packageInformation The target package.
     * @param limit The maximum number of remote dumps to search.
     * @param offset The number of remote dumps to skip.
     * @param ctx The tracing context.
     */
    private async remoteReferences(
        dumpId: pgModels.DumpId,
        repositoryId: number,
        moniker: Pick<sqliteModels.MonikerData, 'scheme' | 'identifier'>,
        packageInformation: Pick<sqliteModels.PackageInformationData, 'name' | 'version'>,
        limit: number,
        offset: number,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; totalCount: number; newOffset: number }> {
        const { references, totalCount, newOffset } = await this.dependencyManager.getReferences({
            repositoryId,
            scheme: moniker.scheme,
            identifier: moniker.identifier,
            name: packageInformation.name,
            version: packageInformation.version,
            limit,
            offset,
        })

        const dumps = references.map(r => r.dump)
        const locations = await this.locationsFromRemoteReferences(dumpId, moniker, dumps, ctx)
        return { locations, totalCount, newOffset }
    }

    /**
     * Find the references of the target moniker outside of the current dump but within a dump of
     * the same repository. If the moniker has attached package information, then the dependency
     * database is queried for the packages that require this particular moniker identifier. These
     * dumps are opened, and their references tables are queried for the target moniker.
     *
     * @param dumpId The ID of the dump for which this database answers queries.
     * @param repositoryId The repository identifier for which this database answers queries.
     * @param commit The commit of the references query.
     * @param moniker The target moniker.
     * @param packageInformation The target package.
     * @param limit The maximum number of remote dumps to search.
     * @param offset The number of remote dumps to skip.
     * @param ctx The tracing context.
     */
    private async sameRepositoryRemoteReferences(
        dumpId: pgModels.DumpId,
        repositoryId: number,
        commit: string,
        moniker: Pick<sqliteModels.MonikerData, 'scheme' | 'identifier'>,
        packageInformation: Pick<sqliteModels.PackageInformationData, 'name' | 'version'>,
        limit: number,
        offset: number,
        ctx: TracingContext = {}
    ): Promise<{ locations: InternalLocation[]; totalCount: number; newOffset: number }> {
        const { references, totalCount, newOffset } = await this.dependencyManager.getSameRepoRemoteReferences({
            repositoryId,
            commit,
            scheme: moniker.scheme,
            identifier: moniker.identifier,
            name: packageInformation.name,
            version: packageInformation.version,
            limit,
            offset,
        })

        const dumps = references.map(r => r.dump)
        const locations = await this.locationsFromRemoteReferences(dumpId, moniker, dumps, ctx)
        return { locations, totalCount, newOffset }
    }

    /**
     * Query the given dumps for references to the given moniker.
     *
     * @param dumpId The ID of the dump for which this database answers queries.
     * @param moniker The target moniker.
     * @param dumps The dumps to open.
     * @param ctx The tracing context.
     */
    private async locationsFromRemoteReferences(
        dumpId: pgModels.DumpId,
        moniker: Pick<sqliteModels.MonikerData, 'scheme' | 'identifier'>,
        dumps: pgModels.LsifDump[],
        ctx: TracingContext = {}
    ): Promise<InternalLocation[]> {
        logSpan(ctx, 'package_references', {
            references: dumps.map(d => ({ repositoryId: d.repositoryId, commit: d.commit })),
        })

        let locations: InternalLocation[] = []
        for (const dump of dumps) {
            // Skip the remote reference that show up for ourselves - we've already gathered
            // these in the previous step of the references query.
            if (dump.id === dumpId) {
                continue
            }

            const { locations: monikerResults } = await this.createDatabase(dump).monikerResults(
                sqliteModels.ReferenceModel,
                moniker,
                {},
                ctx
            )
            const references = monikerResults.map(loc => locationFromDatabase(dump.root, loc))
            locations = locations.concat(references)
        }

        return locations
    }

    /**
     * Create a database instance for the dump identifier. This identifier should have ben retrieved
     * from a call to the `exists` route, which would have this identifier from `findClosestDatabase`.
     * Also returns the dump instance backing the database. Returns an undefined database and dump if
     * no such dump can be found. Will also return a tracing context tagged with the closest commit
     * found. This new tracing context should be used in all downstream requests so that the original
     * commit and the effective commit are both known.
     *
     * If no dumpId is supplied, the first database from `findClosestDatabase` is used. Note that this
     * functionality does not happen in the application and only in tests, as an uploadId is a required
     * parameter on all routes into the API.
     *
     * @param repositoryId The repository identifier.
     * @param commit The target commit.
     * @param path One of the files in the dump.
     * @param dumpId The identifier of the dump to load.
     * @param ctx The tracing context.
     */
    private async closestDatabase(
        repositoryId: number,
        commit: string,
        path: string,
        dumpId?: number,
        ctx: TracingContext = {}
    ): Promise<{ database: Database; dump: pgModels.LsifDump; ctx: TracingContext } | undefined> {
        if (!dumpId) {
            const databases = await this.findClosestDatabases(repositoryId, commit, path)
            return databases.length > 0 ? databases[0] : undefined
        }

        const dump = await this.dumpManager.getDumpById(dumpId)
        if (!dump) {
            return undefined
        }

        return { database: this.createDatabase(dump), dump, ctx: addTags(ctx, { closestCommit: dump.commit }) }
    }

    /**
     * Create a set of database instances for the given repository at the closest commits to the
     * target commit. This method returns only databases that contain the given file. Also returns
     * the dump instance backing the database. Returns an undefined database and dump if no such
     * dump can be found. Will also return a tracing context tagged with the closest commit found.
     * This new tracing context should be used in all downstream requests so that the original
     * commit and the effective commit are both known.
     *
     * This method returns databases ordered by commit distance (nearest first).
     *
     * @param repositoryId The repository identifier.
     * @param commit The target commit.
     * @param path One of the files in the dump.
     * @param ctx The tracing context
     */
    private async findClosestDatabases(
        repositoryId: number,
        commit: string,
        path: string,
        ctx: TracingContext = {}
    ): Promise<{ database: Database; dump: pgModels.LsifDump; ctx: TracingContext }[]> {
        // Find all closest dumps. Each database is guaranteed to have a root that is a
        // prefix of the given path, but does not guarantee that the path actually exists
        // in that dump.

        const closestDumps = await this.dumpManager.findClosestDumps(repositoryId, commit, path, ctx, this.frontendUrl)

        // Concurrently ensure that each database contains the target file. If it does
        // not contain data for that file, return undefined and filter it from the list
        // before returning.

        return (
            await Promise.all(
                closestDumps.map(async dump => {
                    const database = this.createDatabase(dump)
                    const taggedCtx = addTags(ctx, { closestCommit: dump.commit })

                    return (await database.exists(pathToDatabase(dump.root, path), taggedCtx))
                        ? { database, dump, ctx: taggedCtx }
                        : undefined
                })
            )
        ).filter(isDefined)
    }

    /**
     * Create a database instance backed by the given dump.
     *
     * @param dump The dump.
     */
    private createDatabase(dump: pgModels.LsifDump): Database {
        return new Database(
            this.connectionCache,
            this.documentCache,
            this.resultChunkCache,
            dump,
            dbFilename(this.storageRoot, dump.id)
        )
    }
}
