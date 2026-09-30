package ai.impo.nativebridge

import ai.impo.client.wireTimestamp
import java.text.Normalizer
import java.time.Instant
import java.time.LocalDate
import java.time.MonthDay
import java.util.Locale
import kotlinx.serialization.json.*

/** The same bounded read-only request accepted by the Impo device-tool protocol. */
internal data class ContactSearchInput(val query: String, val limit: Int) {
    private val folded = fold(query)
    private val digits = phoneDigits(query)
    fun matchesText(value: String?) = !value.isNullOrBlank() && fold(value).contains(folded)
    fun matchesPhone(value: String?) = digits.length >= 4 && phoneDigits(value.orEmpty()).contains(digits)

    companion object {
        fun parse(input: JsonElement): ContactSearchInput {
            val fields = input as? JsonObject ?: error("invalid_arguments")
            require(fields.keys == setOf("query", "limit")) { "invalid_arguments" }
            val query = (fields["query"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
                ?: error("invalid_query")
            require(query.length in 1..100 && !query.contains('\u0000')) { "invalid_query" }
            val limit = (fields["limit"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                ?: error("invalid_limit")
            require(limit in 1..25) { "invalid_limit" }
            return ContactSearchInput(query, limit)
        }
        private fun fold(value: String) = Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)
        private fun phoneDigits(value: String) = buildString {
            value.forEach { character -> Character.digit(character, 10).takeIf { it >= 0 }?.let(::append) }
        }
    }
}

/** Accumulates one provider contact; searches every permitted row but retains bounded fields. */
internal class ContactCandidate(private val input: ContactSearchInput, id: String, displayName: String?) {
    var matches = input.matchesText(displayName)
        private set
    var truncated = false
        private set
    private val id = bounded(id, 512)
    private val name = bounded(displayName, 200)
    private var nickname: String? = null
    private var organization: String? = null
    private var jobTitle: String? = null
    private var birthday: String? = null
    private val phones = linkedMapOf<String, JsonObject>()
    private val emails = linkedMapOf<String, JsonObject>()

    fun addName(value: String?) { matches = matches || input.matchesText(value) }
    fun addNickname(value: String?) {
        matches = matches || input.matchesText(value)
        if (nickname == null) nickname = bounded(value, 100)
    }
    fun addOrganization(value: String?, title: String?) {
        matches = matches || input.matchesText(value)
        if (organization == null) organization = bounded(value, 150)
        if (jobTitle == null) jobTitle = bounded(title, 150)
    }
    fun addPhone(number: String?, label: String?) {
        matches = matches || input.matchesPhone(number)
        addLabeled(phones, "number", number, label, 64)
    }
    fun addEmail(address: String?, label: String?) {
        matches = matches || input.matchesText(address)
        addLabeled(emails, "address", address, label, 254)
    }
    fun addBirthday(value: String?) {
        if (birthday == null) birthday = normalizedBirthday(value)
    }
    fun toJson() = buildJsonObject {
        put("id", id.orEmpty()); put("name", name ?: nickname.orEmpty())
        put("nickname", optional(nickname)); put("organization", optional(organization)); put("job_title", optional(jobTitle))
        put("phones", JsonArray(phones.values.toList())); put("emails", JsonArray(emails.values.toList()))
        put("birthday", optional(birthday))
    }
    private fun addLabeled(target: MutableMap<String, JsonObject>, key: String, value: String?, label: String?, maximum: Int) {
        if (value.isNullOrBlank()) return
        val safe = bounded(value, maximum) ?: return
        if (safe in target) return
        if (target.size >= 5) { truncated = true; return }
        target[safe] = buildJsonObject { put(key, safe); put("label", optional(bounded(label, 50))) }
    }
    private fun bounded(value: String?, maximum: Int): String? {
        if (value.isNullOrBlank()) return null
        val clean = value.replace("\u0000", "")
        var result = clean.take(maximum)
        if (result.lastOrNull()?.isHighSurrogate() == true) result = result.dropLast(1)
        if (result != value) truncated = true
        return result.takeIf { it.isNotBlank() }
    }
    private fun optional(value: String?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull
}

internal fun normalizedBirthday(value: String?): String? = runCatching {
    when {
        value == null -> null
        value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) -> LocalDate.parse(value).toString()
        value.matches(Regex("--[0-9]{2}-[0-9]{2}")) -> MonthDay.parse(value).toString()
        else -> null
    }
}.getOrNull()

internal class ContactSearchResults(private val input: ContactSearchInput) {
    private val contacts = mutableListOf<JsonObject>()
    private var more = false
    private var fieldsTruncated = false

    /** False means the requested results and one additional matching contact are known. */
    fun accept(contact: ContactCandidate): Boolean {
        if (!contact.matches) return true
        if (contacts.size == input.limit) { more = true; return false }
        contacts += contact.toJson()
        fieldsTruncated = fieldsTruncated || contact.truncated
        return true
    }
    fun envelope(observedAt: Instant = Instant.now()) = DeviceOutputBudget.bound(buildJsonObject {
        put("source", "android.contacts_provider"); put("observed_at", wireTimestamp(observedAt))
        put("contacts", JsonArray(contacts)); put("returned_count", contacts.size)
        put("truncated", more || fieldsTruncated); put("text_fields_truncated", fieldsTruncated)
        put("notes_included", false)
    })
}
