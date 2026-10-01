import { ListeningBatchRepository } from './db/repositories/listening-batch-repository.js';
import { TodayRepository } from './db/repositories/today-repository.js';
import { todayStep } from './today/worker.js';
import { createMemoryStore } from './memory/index.js';
import { MemoryRepository } from './db/repositories/memory-repository.js';
import { memoryStep } from './memory/worker.js';
import { createListeningActivities } from './listening/temporal/activities.js';
import { createTemporalWorker } from './temporal/worker.js';
import { createBackgroundActivities } from './background/activities.js';
import { createBackgroundClient } from './background/client.js';
import { BackgroundUserRepository } from './db/repositories/background-repository.js';
import { BackgroundProvisioner } from './background/provisioner.js';
import { ListeningRepository } from './db/repositories/listening-repository.js';
import { ListeningWorker } from './listening/worker.js';
import { S3TranscriptArchive } from './listening/transcript-archive.js';
import { S3AudioObjectStore } from './listening/audio-upload.js';
import { DevelopmentTranscriber, GeminiTranscriber } from './listening/transcriber.js';
import { loadConfig, databaseRequiresSsl } from './config.js';
import { createDatabase } from './db/client.js';
import { createRuntimeRepository } from './runtime.js';
import { RebyteRepository } from './db/repositories/rebyte-repository.js';
import { RebyteGateway } from './rebyte/gateway.js';
import { RebyteWorker } from './worker/rebyte-worker.js';
import { DevelopmentWorker } from './worker/worker.js';
import { NotificationRepository } from './db/repositories/notification-repository.js';
import { FCMSender } from './notifications/fcm.js';
import { notificationActivities, NotificationProvisioner } from './notifications/worker.js';
import { AccountDeletionRepository } from './db/repositories/account-deletion-repository.js';
import { accountDeletionActivities, AccountDeletionProvisioner } from './accounts/worker.js';
import { createAccountCleanup } from './accounts/cleanup.js';
import { EchoScheduleRepository } from './db/repositories/echo-schedule-repository.js';
import { echoScheduleActivities, EchoScheduleProvisioner } from './echo/worker.js';

const config = loadConfig('worker');
if (config.notificationsEnabled && (!config.fcm || !config.temporal)) throw new Error('Notifications require FCM and Temporal configuration');
const database = createDatabase(config.databaseUrl, { ssl: databaseRequiresSsl(config.databaseUrl) });
const controller = new AbortController();
let shuttingDown = false;
let temporal: Awaited<ReturnType<typeof createTemporalWorker>> | undefined;
let background: Awaited<ReturnType<typeof createBackgroundClient>> | undefined;
let memoryStore: ReturnType<typeof createMemoryStore>;
const shutdown = () => { shuttingDown = true; controller.abort(); if (temporal?.worker.getState() === "RUNNING") temporal.worker.shutdown(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  memoryStore = createMemoryStore(database.db, config.memory);
  const repository = createRuntimeRepository(database.db, config, { memories: memoryStore });
  await repository.health();
  const worker = repository instanceof RebyteRepository && config.rebyte
    ? new RebyteWorker(repository, new RebyteGateway(config.rebyte), config)
    : new DevelopmentWorker(repository, config);
  process.stdout.write(JSON.stringify({ event: 'worker_ready', mode: 'development', runtime: config.runtime }) + '\n');
  const transcriber = config.runtime === 'development' ? new DevelopmentTranscriber()
    : config.listening ? new GeminiTranscriber(config.listening) : undefined;
  const archive = config.transcriptArchive ? new S3TranscriptArchive(config.transcriptArchive.bucket, config.transcriptArchive.region) : undefined;
  const audioObjects = config.transcriptArchive ? new S3AudioObjectStore(config.transcriptArchive.bucket, config.transcriptArchive.region) : undefined;
  const listening = transcriber ? new ListeningWorker(new ListeningRepository(database.db, archive), transcriber) : undefined;
  if (process.argv.includes('--once')) { await worker.tick(controller.signal); await listening?.tick(controller.signal); }
  else {
    let provisioner: BackgroundProvisioner | undefined;
    let notificationProvisioner: NotificationProvisioner | undefined;
    let deletionProvisioner: AccountDeletionProvisioner | undefined;
    let echoProvisioner: EchoScheduleProvisioner | undefined;
    if (config.temporal) {
      const users = new BackgroundUserRepository(database.db);
      background = await createBackgroundClient(config.temporal);
      const accounts = new AccountDeletionRepository(database.db);
      deletionProvisioner = new AccountDeletionProvisioner(accounts, background.client, config.temporal.taskQueue);
      temporal = await createTemporalWorker(config.temporal, {
        ...accountDeletionActivities(accounts, createAccountCleanup(config, background.client)),
        ...(config.notificationsEnabled ? echoScheduleActivities(new EchoScheduleRepository(database.db)) : {}),
        ...(config.notificationsEnabled && config.fcm ? notificationActivities(new NotificationRepository(database.db), new FCMSender(config.fcm)) : {}),
        ...createBackgroundActivities(users, config.rebyte ? [
          todayStep(new TodayRepository(database.db, archive, new RebyteGateway(config.rebyte)), new RebyteGateway(config.rebyte), config.rebyte.model),
          ...(memoryStore ? [memoryStep(new MemoryRepository(database.db, archive, new RebyteGateway(config.rebyte)), memoryStore, new RebyteGateway(config.rebyte), { model: config.rebyte.model })] : []),
        ] : []),
        ...(transcriber ? createListeningActivities(new ListeningBatchRepository(database.db), transcriber, archive, audioObjects) : {}),
      });
      provisioner = new BackgroundProvisioner(users, background);
      if (config.notificationsEnabled) notificationProvisioner = new NotificationProvisioner(new NotificationRepository(database.db), background.client, config.temporal.taskQueue);
      if (config.notificationsEnabled) echoProvisioner = new EchoScheduleProvisioner(new EchoScheduleRepository(database.db), background.client, config.temporal.taskQueue);
    }
    const loops = [...(temporal ? [temporal.worker.run()] : []),
      ...(provisioner ? [provisioner.run(controller.signal)] : []),
      ...(notificationProvisioner ? [notificationProvisioner.run(controller.signal)] : []),
      ...(deletionProvisioner ? [deletionProvisioner.run(controller.signal)] : []),
      ...(echoProvisioner ? [echoProvisioner.run(controller.signal)] : []),
      worker.run(controller.signal), ...(listening ? [listening.run(controller.signal)] : [])];
    try { await Promise.all(loops); }
    finally {
      controller.abort();
      if (temporal?.worker.getState() === "RUNNING") temporal.worker.shutdown();
      await Promise.allSettled(loops);
    }
  }
} catch (error) {
  if (!shuttingDown) {
    process.stderr.write(JSON.stringify({ event: 'worker_stopped', error: 'Worker startup or database operation failed' }) + '\n');
    process.exitCode = 1;
  }
} finally {
  await temporal?.close();
  await background?.close();
  memoryStore?.close();
  await database.close();
}
