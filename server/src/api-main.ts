import { AttachmentService, attachmentObjects } from './attachments/service.js';
import { AttachmentRepository } from './db/repositories/attachment-repository.js';
import { ScheduledTaskRepository } from './db/repositories/scheduled-task-repository.js';
import { ListeningBatchRepository } from './db/repositories/listening-batch-repository.js';
import { TodayRepository } from './db/repositories/today-repository.js';
import { createListeningBatchService } from './listening/temporal/client.js';
import { ListeningRepository } from './db/repositories/listening-repository.js';
import { createDatabase } from './db/client.js';
import { loadConfig, databaseRequiresSsl } from './config.js';
import { createApiServer } from './http/api-server.js';
import { DevelopmentDictation, GeminiDictation } from './voice/dictation.js';
import { createRuntimeRepository } from './runtime.js';
import { RebyteGateway } from './rebyte/gateway.js';
import { FileDownloads } from './rebyte/files.js';
import { ProfileRepository } from './db/repositories/profile-repository.js';
import { ConnectorService } from './composio/connector-service.js';
import { ConnectorRepository } from './db/repositories/connector-repository.js';
import { S3TranscriptArchive } from './listening/transcript-archive.js';
import { createMemoryStore } from './memory/index.js';
import { ListeningUploadService, S3AudioObjectStore } from './listening/audio-upload.js';
import { NotificationRepository } from './db/repositories/notification-repository.js';
import { AccountDeletionRepository } from './db/repositories/account-deletion-repository.js';
import { AccountDeletionService } from './accounts/service.js';
import { AppleGrantRevoker } from './accounts/apple.js';
import { EchoScheduleRepository } from './db/repositories/echo-schedule-repository.js';

async function main(): Promise<void> {
  const config = loadConfig('api');
  const database = createDatabase(config.databaseUrl, { ssl: databaseRequiresSsl(config.databaseUrl) });
  const memories = createMemoryStore(database.db, config.memory);
  const repository = createRuntimeRepository(database.db, config, { memories });
  try { await repository.health(); }
  catch (error) { memories?.close(); await database.close(); throw error; }
  const connectors = config.composio ? new ConnectorService(new ConnectorRepository(database.db), config.composio) : undefined;
  connectors?.warm();
  const auth = config.authMode === 'clerk' ? { mode: 'clerk' as const, secretKey: config.clerk!.secretKey } : { mode: 'local-dev' as const };
  const batches = new ListeningBatchRepository(database.db);
  const batchService = config.temporal ? await createListeningBatchService(config.temporal, batches) : undefined;
  const archive = config.transcriptArchive ? new S3TranscriptArchive(config.transcriptArchive.bucket, config.transcriptArchive.region) : undefined;
  const uploads = config.transcriptArchive && batchService ? new ListeningUploadService(batches,
    new S3AudioObjectStore(config.transcriptArchive.bucket, config.transcriptArchive.region), batchService) : undefined;
  const files = config.rebyte ? new FileDownloads(repository, new RebyteGateway(config.rebyte)) : undefined;
  const attachments = config.transcriptArchive ? new AttachmentService(new AttachmentRepository(database.db), attachmentObjects(config.transcriptArchive.bucket, config.transcriptArchive.region)) : undefined;
  const server = createApiServer(repository, { files, attachments, profiles: new ProfileRepository(database.db), uploads, memories, today: new TodayRepository(database.db, archive, config.rebyte ? new RebyteGateway(config.rebyte) : undefined, { connectors, schedulingEnabled: Boolean(config.temporal) }), batches, batchService, pollIntervalMs: config.pollIntervalMs, streamKeepAliveMs: config.streamKeepAliveMs, runtime: config.runtime, connectors, auth, listening: new ListeningRepository(database.db, archive), listeningEnabled: Boolean(config.listening) || config.runtime === 'development',
    notifications: new NotificationRepository(database.db),
    scheduledTasks: config.temporal ? new ScheduledTaskRepository(database.db, repository.runtime) : undefined,
    echoSchedules: config.temporal ? new EchoScheduleRepository(database.db) : undefined,
    accounts: new AccountDeletionService(new AccountDeletionRepository(database.db), config.clerk?.secretKey, config.appleSignIn ? new AppleGrantRevoker(config.appleSignIn) : undefined), accountDeletionEnabled: Boolean(config.temporal),
    gadgetGateway: config.gadgetGatewayServiceToken ? { serviceToken: config.gadgetGatewayServiceToken } : undefined,
    dictation: config.voice ? new GeminiDictation(config.voice) : config.runtime === 'development' ? new DevelopmentDictation() : undefined });
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    // Closing HTTP streams stops only their subscriptions. The Worker owns execution.
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await batchService?.close();
    memories?.close();
    await database.close();
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No API listening address')); return; }
      console.log(JSON.stringify({
        event: 'listening', mode: 'development', runtime: config.runtime === 'rebyte' ? 'rebyte' : 'deterministic',
        port: address.port, url: `http://${config.host === '::1' ? '[::1]' : config.host}:${address.port}/api/v1`,
      }));
      resolve();
    });
  }).catch(async error => { await shutdown(); throw error; });
}

void main().catch(() => {
  // Database driver errors may contain connection details; never dump them to stdout.
  console.error(JSON.stringify({ event: 'startup_failed', message: 'Check development configuration, database readiness and API port.' }));
  process.exitCode = 1;
});
