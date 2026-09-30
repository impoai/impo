package ai.impo.nativebridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.Nickname
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import androidx.core.content.ContextCompat
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Device-only read path. It never asks for permission, writes contacts, or reads notes/photos. */
internal class ContactsAdapter(private val context: Context) {
    val granted get() = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    suspend fun search(arguments: JsonElement): JsonObject {
        val input = ContactSearchInput.parse(arguments)
        check(granted) { "permission_required" }
        val coroutine = currentCoroutineContext()
        coroutine.ensureActive()
        val results = ContactSearchResults(input)
        val projection = arrayOf(Data.CONTACT_ID, Data.DISPLAY_NAME_PRIMARY, Data.MIMETYPE,
            Data.DATA1, Data.DATA2, Data.DATA3, Data.DATA4)
        val kinds = arrayOf(StructuredName.CONTENT_ITEM_TYPE, Nickname.CONTENT_ITEM_TYPE,
            Organization.CONTENT_ITEM_TYPE, Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, Event.CONTENT_ITEM_TYPE)
        // Parameters are fixed MIME types, never model-supplied SQL. Sorting groups linked raw
        // contacts so memory stays bounded to one candidate and at most 25 matching contacts.
        val selection = "${Data.MIMETYPE} IN (${kinds.joinToString(",") { "?" }})" +
            " AND (${Data.MIMETYPE} != ? OR ${Data.DATA2} = ?)"
        val selectionArguments = kinds + arrayOf(Event.CONTENT_ITEM_TYPE, Event.TYPE_BIRTHDAY.toString())
        context.contentResolver.query(Data.CONTENT_URI, projection, selection, selectionArguments,
            "${Data.CONTACT_ID} ASC, ${Data._ID} ASC")?.use { cursor ->
            var contactId: String? = null
            var candidate: ContactCandidate? = null
            var stopped = false
            fun value(index: Int): String? = if (cursor.isNull(index)) null else cursor.getString(index)
            while (cursor.moveToNext()) {
                coroutine.ensureActive()
                val nextId = cursor.getLong(0).toString()
                if (nextId != contactId) {
                    if (candidate?.let(results::accept) == false) { stopped = true; break }
                    contactId = nextId
                    candidate = ContactCandidate(input, nextId, value(1))
                }
                val current = checkNotNull(candidate)
                when (value(2)) {
                    StructuredName.CONTENT_ITEM_TYPE -> current.addName(value(3))
                    Nickname.CONTENT_ITEM_TYPE -> current.addNickname(value(3))
                    Organization.CONTENT_ITEM_TYPE -> current.addOrganization(value(3), value(6))
                    Phone.CONTENT_ITEM_TYPE -> current.addPhone(value(3),
                        Phone.getTypeLabel(context.resources, cursor.getInt(4), value(5)).toString())
                    Email.CONTENT_ITEM_TYPE -> current.addEmail(value(3),
                        Email.getTypeLabel(context.resources, cursor.getInt(4), value(5)).toString())
                    Event.CONTENT_ITEM_TYPE -> if (cursor.getInt(4) == Event.TYPE_BIRTHDAY) current.addBirthday(value(3))
                }
            }
            if (!stopped) candidate?.let(results::accept)
        } ?: error("contacts_unavailable")
        coroutine.ensureActive()
        check(granted) { "permission_revoked" }
        return results.envelope()
    }
}
