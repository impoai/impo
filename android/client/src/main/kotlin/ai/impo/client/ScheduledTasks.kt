package ai.impo.client

import kotlinx.serialization.Serializable

@Serializable data class TaskSchedule(
    val frequency: String = "daily", val timeZone: String = java.time.ZoneId.systemDefault().id,
    val runAt: String? = null, val time: String? = "09:00", val weekdays: List<Int> = emptyList(),
)
@Serializable data class ScheduledTaskInput(val title: String, val goal: String, val schedule: TaskSchedule, val enabled: Boolean = true)
@Serializable data class ScheduledTask(
    val id: String, val title: String, val goal: String, val schedule: TaskSchedule, val enabled: Boolean,
    val revision: String, val nextRunAt: String?, val createdAt: String, val updatedAt: String,
) { val input get() = ScheduledTaskInput(title, goal, schedule, enabled) }
@Serializable data class ScheduledTasksResponse(val schedules: List<ScheduledTask>)
@Serializable data class ScheduledTaskRun(val id: String, val taskId: String?, val scheduledAt: String, val createdAt: String, val status: String)
@Serializable data class ScheduledTaskRunPage(val runs: List<ScheduledTaskRun>, val nextCursor: String?)
@Serializable internal data class ScheduleDeletionReceipt(val deleted: Boolean)
