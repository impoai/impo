package ai.impo.data

import ai.impo.client.AppRelease
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Owned by Application: activity recreation, account changes and resume never recheck. */
class SoftUpgrade {
    private var checked = false
    private val mutable = MutableStateFlow<AppRelease?>(null)
    val available = mutable.asStateFlow()
    fun checkOnce(scope: CoroutineScope, load: suspend () -> AppRelease?) {
        if (checked) return
        checked = true
        scope.launch { mutable.value = runCatching { load() }.getOrNull() }
    }
    fun dismiss() { mutable.value = null }
}
