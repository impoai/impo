package ai.impo.nativebridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import java.time.Instant
import java.util.Locale
import ai.impo.client.BriefLocation
import ai.impo.client.wireTimestamp
import kotlin.coroutines.resume
import kotlinx.coroutines.*

/** A stopped capture's subscription cannot be revived by delayed initialization. */
internal class LocationSubscription(private val register: () -> Boolean, private val unregister: () -> Unit) {
    @Volatile var active: Boolean = false
        private set
    private var stopped = false

    @Synchronized fun start() {
        if (!stopped && !active) active = register()
    }

    @Synchronized fun stop() {
        if (stopped) return
        stopped = true
        active = false
        unregister()
    }
}

/** Coordinates exist only during a geocoder call, never in files or API DTOs. */
internal class RecordingLocation(private val context: Context, val history: EchoLocationHistory) : LocationListener {
    private val manager = context.getSystemService(LocationManager::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var lookup: Job? = null
    private var lastLookup = 0L
    // The callback checks current permission; start() also catches revocation
    // between that check and registration. Lint cannot follow this callback.
    @Suppress("MissingPermission")
    private val subscription = LocationSubscription(register = {
        if (!hasPermission(context)) false else {
            val provider = when {
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> null
            }
            if (provider == null) false else {
                manager.requestLocationUpdates(provider, 30_000, 0f, this, Looper.getMainLooper())
                true
            }
        }
    }, unregister = { runCatching { manager.removeUpdates(this) }; Unit })

    fun start() {
        try { subscription.start() } catch (_: SecurityException) { stop() }
    }

    @Suppress("DEPRECATION")
    override fun onLocationChanged(location: Location) {
        val now = Instant.now()
        if (!subscription.active || !hasPermission(context) || !Geocoder.isPresent() || !location.hasAccuracy() ||
            location.accuracy !in 0f..5000f || location.time > now.toEpochMilli() ||
            now.toEpochMilli() - location.time > 60_000 || now.toEpochMilli() - lastLookup < 30_000 || lookup?.isActive == true) return
        lastLookup = now.toEpochMilli()
        lookup = scope.launch {
            try {
                val place = Geocoder(context, Locale.ENGLISH).getFromLocation(location.latitude, location.longitude, 1)?.firstOrNull()
                if (subscription.active && isActive && hasPermission(context) && place != null) {
                    val city = place.locality ?: place.adminArea
                    val country = place.countryName
                    if (!city.isNullOrBlank() && !country.isNullOrBlank()) {
                        history.add(PlaceFix(Instant.ofEpochMilli(location.time), location.accuracy.toDouble(),
                            clean(city), clean(country), place.subLocality?.takeIf { location.accuracy <= 500 }?.let(::clean)))
                    }
                }
            } catch (_: Exception) { /* Missing or unresolved places stay unknown. */ }
        }
    }

    fun stop() {
        subscription.stop(); history.pause(); lookup?.cancel(); scope.cancel()
    }
    private fun clean(value: String) = value.filterNot { it.isISOControl() }.take(100)

    companion object {
        fun hasPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }
}

/** A user-requested city snapshot for Brief; never starts ongoing location tracking. */
object BriefCityReader {
    @Suppress("MissingPermission", "DEPRECATION")
    suspend fun read(context: Context): BriefLocation = withTimeout(20_000) {
        check(RecordingLocation.hasPermission(context)) { "Location permission is needed to find your city." }
        check(Geocoder.isPresent()) { "Place lookup is unavailable on this device. Enter a city manually." }
        val manager = context.getSystemService(LocationManager::class.java)
        val provider = when {
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            else -> error("Location is off in Android. Enter a city or enable location.")
        }
        val known = manager.getLastKnownLocation(provider)?.takeIf { fix ->
            fix.time <= System.currentTimeMillis() && System.currentTimeMillis() - fix.time <= 60_000 && fix.hasAccuracy() && fix.accuracy in 0f..5000f
        }
        val fix = known ?: suspendCancellableCoroutine { continuation ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    manager.removeUpdates(this)
                    if (continuation.isActive) continuation.resume(location)
                }
            }
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            continuation.invokeOnCancellation { runCatching { manager.removeUpdates(listener) } }
        }
        check(fix.hasAccuracy() && fix.accuracy in 0f..5000f && fix.time <= System.currentTimeMillis() && System.currentTimeMillis() - fix.time <= 60_000) {
            "A recent location wasn't available. You can enter your city manually."
        }
        val place = withContext(Dispatchers.IO) {
            Geocoder(context, Locale.ENGLISH).getFromLocation(fix.latitude, fix.longitude, 1)?.firstOrNull()
        }
        check(RecordingLocation.hasPermission(context)) { "Location permission was removed." }
        val city = (place?.locality ?: place?.adminArea)?.filterNot { it.isISOControl() }?.take(100)
        val country = place?.countryName?.filterNot { it.isISOControl() }?.take(100)
        check(!city.isNullOrBlank() && !country.isNullOrBlank()) { "Your city couldn't be resolved. Enter it manually." }
        BriefLocation(city, country, wireTimestamp(Instant.ofEpochMilli(fix.time)), "device")
    }
}
