import { createTemporalWorker } from '../../temporal/worker.js';
import { createListeningActivities } from './activities.js';
import type { ListeningBatchRepository } from '../batch-repository.js';
import type { BatchTranscriber } from '../transcriber.js';
import type { TemporalOptions } from './client.js';
import type { TranscriptArchive } from '../transcript-archive.js';
import type { AudioObjectStore } from '../audio-upload.js';
export async function createListeningTemporalWorker(config:TemporalOptions,repository:ListeningBatchRepository,transcriber:BatchTranscriber,archive?:TranscriptArchive,objects?:AudioObjectStore){
 return createTemporalWorker(config,createListeningActivities(repository,transcriber,archive,objects));
}
