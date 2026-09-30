package ai.impo.nativebridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import ai.impo.client.ApiException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** WorkManager transfers already sealed files. It never owns or starts a microphone. */
class EchoUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = uploadLock.withLock {
        val current = NativeBridge.account() ?: return@withLock Result.retry()
        val requested = inputData.getString("accountId")
        if (requested != null && current.accountId != requested) return@withLock Result.success()
        if (NativeBridge.wifiOnly(applicationContext) && !onWifi(applicationContext)) return@withLock Result.retry()
        val store = NativeBridge.store(applicationContext, current.accountId)
        try {
            var retry = false
            for (batchId in store.pendingBatchIds()) {
                // The API client is also bound to this account; both boundaries
                // reject an account switch between prepare, PUT and acceptance.
                try {
                    val pending = store.loadPending(batchId)
                    requireCurrent(current.accountId)
                    val ticket = current.api.prepareAudioUpload(pending.manifest)
                    requireCurrent(current.accountId)
                    val receipt = when (ticket.status) {
                        "accepted" -> checkNotNull(ticket.receipt)
                        "upload" -> {
                            current.api.uploadAudio(ticket, pending.bytes)
                            requireCurrent(current.accountId)
                            current.api.completeAudioUpload(pending.manifest.batch.batchId)
                        }
                        "uploaded" -> current.api.completeAudioUpload(pending.manifest.batch.batchId)
                        else -> error("Unknown upload status")
                    }
                    requireCurrent(current.accountId)
                    store.acknowledge(receipt)
                } catch (cancelled: CancellationException) { throw cancelled }
                  catch (failure: ApiException) {
                    if (failure.statusCode == 410) store.markDeleted(batchId)
                    else retry = true
                } catch (_: Exception) { retry = true }
                if (NativeBridge.account()?.accountId != current.accountId) return@withLock Result.success()
                if (NativeBridge.wifiOnly(applicationContext) && !onWifi(applicationContext)) {
                    return@withLock Result.retry()
                }
                NativeBridge.refreshPending(applicationContext, current.accountId)
            }
            if (retry) {
                NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(message = "Audio is saved on this device. Upload will retry.")
                Result.retry()
            } else Result.success()
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) {
            NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(message = "Audio is saved on this device. Upload will retry.")
            Result.retry()
        }
    }

    private fun requireCurrent(accountId: String) { check(NativeBridge.account()?.accountId == accountId) { "Account changed" } }

    companion object {
        private val uploadLock = Mutex()
        fun enqueue(context: Context, accountId: String, replace: Boolean = false) {
            val constraint = if (NativeBridge.wifiOnly(context)) NetworkType.UNMETERED else NetworkType.CONNECTED
            val request = OneTimeWorkRequestBuilder<EchoUploadWorker>()
                .setInputData(workDataOf("accountId" to accountId))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(constraint).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("echo_upload_${sha256(accountId.toByteArray())}",
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
        }
        fun scheduleMaintenance(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("echo_upload_maintenance", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<EchoUploadWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
        private fun onWifi(context: Context): Boolean {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            return manager.getNetworkCapabilities(manager.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
    }
}
