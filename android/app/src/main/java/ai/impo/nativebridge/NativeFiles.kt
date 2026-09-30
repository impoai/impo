package ai.impo.nativebridge

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Account IDs and server resource IDs never become filesystem paths. */
internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

internal fun canonicalJson(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.toSortedMap().mapValues { canonicalJson(it.value) })
    is JsonArray -> JsonArray(value.map(::canonicalJson))
    else -> value
}

internal fun accountDirectory(root: File, accountId: String): File {
    require(accountId.isNotBlank())
    return File(root, sha256(accountId.toByteArray(Charsets.UTF_8))).apply { mkdirs() }
}

/** Rename only after the bytes reach storage. Readers never observe half a receipt. */
internal fun atomicWrite(file: File, bytes: ByteArray) {
    file.parentFile?.mkdirs()
    val temporary = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temporary).use { output -> output.write(bytes); output.fd.sync() }
    Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
}
