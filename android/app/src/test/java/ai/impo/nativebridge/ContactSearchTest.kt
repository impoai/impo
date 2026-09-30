package ai.impo.nativebridge

import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ContactSearchTest {
    private fun arguments(query: String, limit: Int = 5) = buildJsonObject { put("query", query); put("limit", limit) }
    private fun candidate(query: String, name: String = "Someone") = ContactCandidate(ContactSearchInput(query, 5), "42", name)

    @Test fun protocolRejectsUnboundedOrAmbiguousRequests() {
        val valid = arguments(" Alice ")
        assertEquals(ContactSearchInput("Alice", 5), ContactSearchInput.parse(valid))
        val invalid = listOf(
            JsonNull, JsonObject(valid - "limit"), JsonObject(valid + ("write" to JsonPrimitive(true))),
            arguments(""), arguments("   "), arguments("\u0000name"), arguments("a".repeat(101)),
            arguments("a", 0), arguments("a", 26), JsonObject(valid + ("limit" to JsonPrimitive("5"))),
            JsonObject(valid + ("limit" to JsonPrimitive(1.5))), JsonObject(valid + ("query" to JsonPrimitive(123))),
        )
        invalid.forEach { assertThrows(RuntimeException::class.java) { ContactSearchInput.parse(it) } }
    }

    @Test fun namesNicknamesOrganizationsAndEmailSearchAcrossLanguages() {
        assertTrue(candidate("elodie", "Élodie Martin").matches)
        assertTrue(candidate("小明", "王小明").matches)
        assertTrue(candidate("Ally").apply { addNickname("ALLY") }.matches)
        assertTrue(candidate("研究").apply { addOrganization("森林研究所", "Engineer") }.matches)
        assertTrue(candidate("EXAMPLE.ORG").apply { addEmail("person@example.org", "Work") }.matches)
        assertTrue(candidate("alternate").apply { addName("Alternate Name") }.matches)
        assertFalse(candidate("unrelated").apply { addOrganization("Forest", "unrelated") }.matches)
    }

    @Test fun phoneMatchingUsesAtLeastFourDigitsAndIgnoresFormatting() {
        assertTrue(candidate("２０２-５５５").apply { addPhone("+1 (202) 555-0199", "Mobile") }.matches)
        assertFalse(candidate("202").apply { addPhone("+1 (202) 555-0199", "Mobile") }.matches)
        assertFalse(candidate("9999").apply { addPhone("+1 (202) 555-0199", "Mobile") }.matches)
    }

    @Test fun fieldsBeyondReturnedLimitStillMatchWithoutGrowingTheResult() {
        val contact = candidate("sixth@example.org")
        repeat(5) { contact.addEmail("$it@example.org", "Work") }
        contact.addEmail("sixth@example.org", "Other")
        assertTrue(contact.matches)
        assertTrue(contact.truncated)
        assertEquals(5, contact.toJson()["emails"]!!.jsonArray.size)
        val linked = candidate("example").apply { repeat(20) { addEmail("same@example.org", "Work") } }
        assertEquals(1, linked.toJson()["emails"]!!.jsonArray.size)
        assertFalse(linked.truncated)
    }

    @Test fun birthdaysPreserveMissingYearAndRejectInvalidDates() {
        assertEquals("--02-29", normalizedBirthday("--02-29"))
        assertEquals("2000-02-29", normalizedBirthday("2000-02-29"))
        listOf(null, "2001-02-29", "--02-30", "09/30/2000", "20000930", "2000-09-30T00:00:00Z").forEach {
            assertNull(normalizedBirthday(it))
        }
        assertEquals(JsonPrimitive("--09-30"), candidate("person").apply { addBirthday("--09-30") }.toJson()["birthday"])
    }

    @Test fun extraMatchingContactMarksTruncationWithoutIncludingUnrelatedPeople() {
        val input = ContactSearchInput("Alice", 1)
        val results = ContactSearchResults(input)
        assertTrue(results.accept(ContactCandidate(input, "1", "Not a match")))
        assertTrue(results.accept(ContactCandidate(input, "2", "Alice Chen")))
        assertFalse(results.envelope()["truncated"]!!.jsonPrimitive.boolean)
        assertFalse(results.accept(ContactCandidate(input, "3", "Alice Smith")))
        val output = results.envelope(Instant.parse("2026-09-30T08:00:00Z"))
        assertTrue(output["truncated"]!!.jsonPrimitive.boolean)
        assertEquals(1, output["returned_count"]!!.jsonPrimitive.int)
        assertEquals("2", output["contacts"]!!.jsonArray.single().jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("android.contacts_provider", output["source"]!!.jsonPrimitive.content)
        assertFalse(output["notes_included"]!!.jsonPrimitive.boolean)
    }

    @Test fun nativeTextIsBoundedWithoutBreakingSurrogatesOrExposingOtherFields() {
        val person = candidate("Hello", "Hello\u0000" + "😀".repeat(200)).apply {
            addOrganization("漢".repeat(200), "Engineer"); addPhone("1".repeat(100), "x".repeat(100))
        }
        val json = person.toJson()
        assertTrue(person.truncated)
        assertEquals(setOf("id", "name", "nickname", "organization", "job_title", "phones", "emails", "birthday"), json.keys)
        val name = json["name"]!!.jsonPrimitive.content
        assertTrue(name.length <= 200)
        assertFalse(name.contains('\u0000'))
        assertFalse(name.last().isHighSurrogate())
        assertEquals(64, json["phones"]!!.jsonArray.single().jsonObject["number"]!!.jsonPrimitive.content.length)
    }

    @Test fun multibyteContactsStayWithinTransportBudgetAndKeepAccurateCounts() {
        val input = ContactSearchInput("漢", 25)
        val results = ContactSearchResults(input)
        repeat(25) { id ->
            val person = ContactCandidate(input, id.toString(), "漢".repeat(200))
            repeat(5) { person.addEmail("漢".repeat(248) + "$it@x.co", "Label") }
            results.accept(person)
        }
        val output = results.envelope()
        assertTrue(output.toString().toByteArray(Charsets.UTF_8).size <= 48 * 1024)
        assertTrue(output["truncated"]!!.jsonPrimitive.boolean)
        assertEquals(output["contacts"]!!.jsonArray.size, output["returned_count"]!!.jsonPrimitive.int)
        assertTrue(output["contacts"]!!.jsonArray.isNotEmpty())
        assertTrue(output["returned_count"]!!.jsonPrimitive.int < 25)
    }
}
