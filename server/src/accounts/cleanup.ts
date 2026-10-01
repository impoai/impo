import { createClerkClient } from '@clerk/backend';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { loadConfig } from '../config.js';
import { RebyteGateway } from '../rebyte/gateway.js';
import { ComposioProvider } from '../composio/provider.js';
import { LocalFileProvider, TursoProvider } from '../memory/provider.js';
import type { AccountCleanup } from './worker.js';

export function createAccountCleanup(config: ReturnType<typeof loadConfig>, temporal: Client): AccountCleanup {
  const rebyte = config.rebyte ? new RebyteGateway(config.rebyte) : undefined;
  const composio = config.composio ? new ComposioProvider(config.composio) : undefined;
  const memory = config.memory ? ('localDirectory' in config.memory ? new LocalFileProvider(config.memory.localDirectory!) : new TursoProvider(config.memory.turso!)) : undefined;
  const s3 = config.transcriptArchive ? new S3Client({ region: config.transcriptArchive.region }) : undefined;
  const clerk = config.clerk ? createClerkClient({ secretKey: config.clerk.secretKey }) : undefined;
  return {
    async workflows(_userId, manifest) {
      let pending = false;
      for (const workflowId of manifest.workflows) {
        if (!/^[a-zA-Z0-9/_:-]+$/.test(workflowId)) throw new Error('Invalid owned workflow ID');
        const remove = async (runId: string) => {
          try { await temporal.workflowService.deleteWorkflowExecution({ namespace: temporal.options.namespace, workflowExecution: { workflowId, runId } }); }
          catch (error) { if ((error as { code?: number }).code !== 5) throw error; }
          // The RPC only queues deletion. Keep the receipt pending until history is gone.
          try { await temporal.workflow.getHandle(workflowId, runId).describe(); pending = true; }
          catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
        };
        // Visibility indexing is eventually consistent. Always remove the current execution directly too.
        try {
          const handle = temporal.workflow.getHandle(workflowId), run = await handle.describe();
          if (run.status.name === 'RUNNING') await handle.terminate('Account deletion');
          await remove(run.runId);
        }
        catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
        // Purge all runs, including Continue-As-New history and legacy audio payloads.
        for await (const run of temporal.workflow.list({ query: `WorkflowId = '${workflowId}'` })) {
          await remove(run.runId);
        }
      }
      if (pending) throw new Error('Workflow history deletion is still pending');
    },
    async rebyte(userId, manifest) {
      if (!rebyte) { if (manifest.sessionIds.length || manifest.agentIds.length) throw new Error('Rebyte cleanup unavailable'); return; }
      await rebyte.deleteAccountResources(userId, manifest.conversationIds, manifest.sessionIds, manifest.agentIds, AbortSignal.timeout(8 * 60_000));
    },
    async connections(_userId, manifest) {
      if (!composio && manifest.connections.length) throw new Error('Connection cleanup unavailable');
      for (const connection of manifest.connections) {
        if (connection.routerId) await composio!.deleteRouter(connection.routerId);
        const ids = new Set([...(await composio!.accounts(connection.entityId, connection.authConfigId)), ...(connection.accountId ? [connection.accountId] : [])]);
        for (const id of ids) {
          try {
            const account = await composio!.account(id);
            if (account.entityId !== connection.entityId || account.authConfigId !== connection.authConfigId) throw new Error('Connection ownership mismatch');
            await composio!.revoke(id);
          } catch (error) { if ((error as { providerStatus?: number }).providerStatus !== 404) throw error; }
        }
      }
    },
    async memory(userId, manifest) {
      if (manifest.memoryDatabaseName !== `impo-mem-${userId}`) throw new Error('Memory ownership mismatch');
      await memory?.delete(manifest.memoryDatabaseName);
    },
    async recordings(userId, manifest) {
      if (!s3) { if (manifest.objectKeys.length && config.runtime !== 'development') throw new Error('Recording cleanup unavailable'); return; }
      if (manifest.objectKeys.some(key => !key.startsWith(`users/${userId}/`) && !key.startsWith(`users/_uploads/${userId}/`))) throw new Error('Recording ownership mismatch');
      for (const Prefix of [`users/${userId}/`, `users/_uploads/${userId}/`]) {
        let ContinuationToken: string | undefined;
        do {
          const page = await s3.send(new ListObjectsV2Command({ Bucket: config.transcriptArchive!.bucket, Prefix, ContinuationToken }));
          const Objects = (page.Contents ?? []).map(object => ({ Key: object.Key! }));
          if (Objects.some(object => !object.Key.startsWith(Prefix))) throw new Error('Recording ownership mismatch');
          if (Objects.length) {
            const result = await s3.send(new DeleteObjectsCommand({ Bucket: config.transcriptArchive!.bucket, Delete: { Objects, Quiet: true } }));
            if (result.Errors?.length) throw new Error('Recording cleanup incomplete');
          }
          ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && !ContinuationToken) throw new Error('Incomplete recording list');
        } while (ContinuationToken);
      }
    },
    async identity(_userId, manifest) {
      if (manifest.authProvider !== 'clerk') return;
      if (!clerk) throw new Error('Identity cleanup unavailable');
      try { await clerk.users.deleteUser(manifest.authSubject); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    },
  };
}
