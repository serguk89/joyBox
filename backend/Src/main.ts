import * as Sqlite3 from 'better-sqlite3';
import * as history from 'connect-history-api-fallback';
import Express = require('express');
import * as fs from 'fs';
import { Server as HTTPServer } from 'http';
import { Server as HTTPSServer } from 'https';
import * as SocketIo from 'socket.io';

import { PluginManager } from './Services/PluginManager';
import { SqliteAdapter } from './Services/SqliteAdapter';
import { SystemResourcesMonitor, SystemResourcesMonitorFactory } from './Services/SystemResourcesMonitor';
import { StreamDispatcher } from './StreamDispatcher';

import { ObservableStream, Plugin } from './Common/Types';
import { BongacamsDirectLocator, BongacamsExtractor, BongacamsLocator } from './Plugins/Bongacams';
import { CamsodaExtractor, CamsodaLocator } from './Plugins/Camsoda';
import { ChaturbateDirectLocator, ChaturbateExtractor } from './Plugins/Chaturbate';
import { DummyExtractor, DummyLocator } from './Plugins/Dummy';
import { LocatorService } from './Plugins/Plugin';
import { NotificationCenter } from './Services/NotificationCenter';
import { RecordingService } from './Services/RecordingService';

import { DOWNLOAD_SPEED_QUOTA, INSTANCE_QUOTA_ID, STORAGE_QUOTA_ID } from '@/Services/PluginManager/Quotas/Constants';
import { AppAccessType, ArchiveRecord, ClipProgressState } from '@Shared/Types';
import { AccessGuard } from './AccessGuard';
import { Config as C } from './BootstrapConfiguration';
import { Broadcaster, RpcRequestHandlerImpl } from './ClientIO';
import { LinkCounter } from './Common/LinkCounter';
import { ConsoleWriter, Logger, SqliteWriter } from './Common/Logger';
import { ARCHIVE_FOLDER, DATA_FOLDER, DB_LOCATION, THUMBNAIL_FOLDER } from './Constants';
import { WebServerFactory } from './WebServerFactory';

import { AppFacade } from './AppFacade';
import { PluginManagerListener } from './PluginManagerListener';
import { RecorderListener } from './RecorderListener';
import { PluginManagerController } from './Services/PluginManager/PluginManagerController';
import { Settings } from './Settings';
import { SocketSameOrigin } from './SocketSameOrigin';

import { DownloadSpeedQuota } from './Services/PluginManager/Quotas/DownloadSpeedQuota';
import { InstanceQuota } from './Services/PluginManager/Quotas/InstanceQuota';
import { StorageQuota } from './Services/PluginManager/Quotas/StorageQuota';

class App {
    // Low level blocks region
    private express: Express.Application;
    private server: HTTPServer | HTTPSServer;
    private io: SocketIo.Server;
    private db!: Sqlite3.Database;
    private storage!: SqliteAdapter;
    private broadcaster: Broadcaster;
    // State region
    private observables: Map<string, ObservableStream> = new Map();
    private archive!: ArchiveRecord[];
    private archiveRefCounter = new LinkCounter<string>();
    private clipProgress: Map<string, ClipProgressState> = new Map();
    private settings!: Settings;
    // Modules region
    private pluginManager: PluginManager = new PluginManager();
    private pluginManagerController = new PluginManagerController(this.pluginManager);
    private linkedStreams: StreamDispatcher = new StreamDispatcher(this.observables);
    private recorder: RecordingService = new RecordingService();
    private systemResourcesMonitor!: SystemResourcesMonitor;
    private notificationCenter!: NotificationCenter;
    // Util region
    private facade!: AppFacade;
    private recorderListener!: RecorderListener;
    private pluginManagerListener!: PluginManagerListener;
    private readonly ARCHIVE_MOUNT_POINT = '/archive';
    constructor() {
        Logger.Get.AddWriter(new ConsoleWriter());
        this.express = Express();
        this.server = new WebServerFactory().Create();
        this.server.on('request', this.express);
        this.io = SocketIo(this.server);

        if (C.Hostname !== '')
            this.io.origins(SocketSameOrigin);

        this.broadcaster = new Broadcaster(this.io);

        if (C.DefaultAccess === AppAccessType.NO_ACCESS) {
            const mediaAccessGuard = new AccessGuard(C.JwtSecret);
            this.express.use(`${this.ARCHIVE_MOUNT_POINT}/*.mp4`, mediaAccessGuard.Middleware);
        }
        this.express.use(this.ARCHIVE_MOUNT_POINT, Express.static('data/archive', { maxAge: 600000 }));

        const staticFrontend = Express.static('client/');
        // For really existing resources, just return them
        this.express.use(staticFrontend);
        // Anything else process via SPA
        this.express.use(history({
            index: '/index.html',
            disableDotRule: true
        }));
        this.express.use(staticFrontend);

        this.RegisterPlugin('bongacams', new BongacamsLocator(new BongacamsExtractor(), 10000));
        this.RegisterPlugin('bongacams_direct', new BongacamsDirectLocator(new BongacamsExtractor(), 10000));
        this.RegisterPlugin('chaturbate', new ChaturbateDirectLocator(new ChaturbateExtractor(), 10000));
        this.RegisterPlugin('camsoda', new CamsodaLocator(new CamsodaExtractor(), 10000));
        this.RegisterPlugin('dummy', new DummyLocator(new DummyExtractor(), 10000));

        this.StartResourceMonitor();
    }

    public RegisterPlugin(name: string, service: LocatorService) {
        this.pluginManager.Register(name, service);
    }

    public Run(): void {
        if (!this.IsDataMounted()) {
            Logger.Get.Log('\'/app/data\' folder doesn\'t exist. Maybe forgot to mount it');
            process.exit(1);
        }

        this.db = new Sqlite3(DB_LOCATION);
        this.storage = new SqliteAdapter(this.db);

        
        if (!this.storage.IsInitialized()) {
            Logger.Get.Log('Database doesn\'t initialized or malformed. Initialization...');
            this.InitializeDb();
        }
        
        this.settings = new Settings(this.storage);
        
        Logger.Get.AddWriter(new SqliteWriter(this.storage));

        try {
            this.PrepareFileSystem();
        } catch (e) {
            Logger.Get.Log(`Preparing filesystem error. ${e}`);
            process.exit(1);
        }

        this.notificationCenter = new NotificationCenter(this.storage);

        this.LoadData();

        process.on('SIGTERM', () => this.Shutdown());

        this.io.on('connection', socket => {
            Logger.Get.Log(`[${socket.id}][${socket.request.connection.remoteAddress}] client connected`);
            new RpcRequestHandlerImpl(
                socket,
                this.broadcaster,
                this.observables,
                this.pluginManager,
                this.pluginManagerController,
                this.pluginManagerListener,
                this.storage,
                this.linkedStreams,
                this.archive,
                this.archiveRefCounter,
                this.clipProgress,
                this.recorder,
                this.systemResourcesMonitor,
                this.notificationCenter,
                this.settings,
                () => this.Shutdown());

            socket.on('disconnect', () => {
                Logger.Get.Log(`[${socket.id}] client disconnected`);
            });
        });
        this.linkedStreams.Initialize();
        this.pluginManager.Start();

        this.facade = new AppFacade(
            this.storage,
            this.broadcaster,
            this.observables,
            this.archive,
            this.pluginManager,
            this.linkedStreams,
            this.recorder,
            this.notificationCenter);

        this.recorderListener = new RecorderListener(this.facade);
        this.pluginManagerListener = new PluginManagerListener(this.facade);
        this.server.listen(C.Port);
    }

    public IsDataMounted(): boolean {
        return fs.existsSync(DATA_FOLDER);
    }

    public InitializeDb(): void {
        this.storage.Initialize(this.pluginManager.Plugins.map(x => x.name));
    }

    /**
     * Prepares the file system if necessary.
     * ├── data/
     *     ├── archive/
     *          ├── thumbnail/
     */
    public PrepareFileSystem() {
        if (!fs.existsSync(ARCHIVE_FOLDER)) {
            fs.mkdirSync(ARCHIVE_FOLDER);
            fs.mkdirSync(THUMBNAIL_FOLDER);
        } else if (!fs.existsSync(THUMBNAIL_FOLDER)) {
            fs.mkdirSync(THUMBNAIL_FOLDER);
        }
    }

    public LoadData(): void {
        const pluginState = this.storage.FetchPlugins();

        pluginState.forEach(x => {
            const p = this.pluginManager.FindPlugin(x.name);

            if (p === null) {
                return;
            }

            p.id = x.id;
            p.enabled = x.enabled;

            const observables = new Set<string>();
            p.service.SetObservables(observables);
            this.linkedStreams.AddPlugin(p.id, observables);
        });
        this.pluginManager.ReorderPlugins(pluginState.map(x => x.id));

        this.storage
            .FetchObservables()
            .forEach(x => {
                const plugins: Plugin[] = [];
                for (const name of x.plugins) {
                    const plugin = this.pluginManager.FindPlugin(name);

                    if (plugin === null) {
                        Logger.Get.Log(`${x.url} has missing plugin '${name}'`);
                        return;
                    }
                    plugins.push(plugin);
                }

                this.observables.set(x.url, { url: x.url, lastSeen: x.lastSeen, plugins });
            });

        this.archive = this.storage.FetchArchiveRecords()
            .map(x => ({ ...x, locked: false, tags: new Set<string>() }));

        this.storage.FetchArchiveTags()
            .forEach(x => this.archive.find(y => y.filename === x.filename)?.tags.add(x.tag));
    }
    private async StartResourceMonitor() {
        this.systemResourcesMonitor =
            await new SystemResourcesMonitorFactory(ARCHIVE_FOLDER, 10000).Create();
        this.systemResourcesMonitor.OnUpdate.On(x => this.broadcaster.SystemMonitorUpdate(x));

        this.SetupPluginManagerController();

        this.systemResourcesMonitor.Start();
    }
    private SetupPluginManagerController() {
        const settings = this.storage.FetchSettings();
        if (settings.storageQuota > 0) {
            const arbiter = new StorageQuota(this.recorder, this.systemResourcesMonitor);
            arbiter.Quota = settings.storageQuota;

            this.pluginManagerController.AddArbiter(arbiter, STORAGE_QUOTA_ID);
        }

        if (settings.instanceQuota > 0) {
            const arbiter = new InstanceQuota(this.pluginManager, this.recorder);
            arbiter.Quota = settings.instanceQuota;

            this.pluginManagerController.AddArbiter(arbiter, INSTANCE_QUOTA_ID);
        }

        if (settings.downloadSpeedQuota > 0) {
            const arbiter = new DownloadSpeedQuota(this.pluginManager, this.recorder);
            arbiter.Quota = settings.downloadSpeedQuota;

            RpcRequestHandlerImpl.pluginListenerInterceptFn = e => arbiter.StreamFilter(e);
            this.pluginManagerListener.AddInterceptor(RpcRequestHandlerImpl.pluginListenerInterceptFn);

            this.pluginManagerController.AddArbiter(arbiter, DOWNLOAD_SPEED_QUOTA);
        }
    }
    private async Shutdown() {
        Logger.Get.Log('Shutting down. Waiting for recorder stops.');
        const StopRecorder = () => {
            return new Promise((resolve) => {
                let awaitedRecordings = this.recorder.Records.length;
                if (!awaitedRecordings) {
                    resolve();
                    return;
                }
                this.pluginManager.Stop();
                this.recorder.Records
                    .map(r => r.label)
                    .forEach(l => this.recorder.StopRecording(l));
                this.recorderListener.CompleteEvent.On(() => {
                    if (--awaitedRecordings === 0)
                        resolve();
                });

            });
        };
        await StopRecorder();
        Logger.Get.Log('Exit');
        process.exit(0);
    }
}

const app = new App();
app.Run();
