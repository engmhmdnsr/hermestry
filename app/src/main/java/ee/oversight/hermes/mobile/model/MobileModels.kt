package ee.oversight.hermes.mobile.model

data class MobileSession(
  val id: String,
  val title: String,
  val model: String = "",
  val messageCount: Int = 0,
  val lastActiveAt: Long = 0L,
  val costUsd: Double = 0.0,
  val source: String = ""
)

data class ChatMessage(
  val id: String,
  val sender: String, // "you" or "hermes"
  val content: String,
  val thinking: String = "",
  val thinkingDone: Boolean = true,
  val tools: List<String> = emptyList()
)

data class CronJob(
  val id: String,
  val name: String,
  val scheduleDisplay: String,
  val prompt: String,
  val enabled: Boolean,
  val state: String = "",
  val nextRunAt: String = "",
  val lastStatus: String = "",
  val lastError: String = ""
)

data class AiModelInfo(val id: String, val displayName: String)

data class PendingApproval(
  val runId: String,
  val sessionId: String,
  val summary: String
)

data class GatewayStatus(
  val ok: Boolean,
  val version: String = "",
  val gatewayState: String = "",
  val platforms: Map<String, String> = emptyMap(),
  val detail: String = ""
)

data class CronRun(
  val id: String,
  val jobId: String = "",
  val status: String = "",
  val startedAt: String = "",
  val finishedAt: String = "",
  val error: String = ""
)

data class Blueprint(
  val id: String,
  val name: String,
  val description: String = ""
)

data class UsageAnalytics(
  val range: String = "",
  val sessions: Int = 0,
  val messages: Int = 0,
  val costUsd: Double = 0.0,
  val inputTokens: Long = 0L,
  val outputTokens: Long = 0L
)

data class LogLine(
  val timestamp: String = "",
  val level: String = "",
  val file: String = "",
  val message: String = ""
)

data class OpsResult(val ok: Boolean, val message: String = "")

data class OpsStatus(val name: String, val state: String = "", val detail: String = "")

data class DebugShare(val urls: List<String> = emptyList(), val summary: String = "")

data class DoctorCheck(val name: String, val ok: Boolean = true, val detail: String = "")

data class DoctorReport(
  val ok: Boolean,
  val summary: String = "",
  val version: String = "",
  val checks: List<DoctorCheck> = emptyList()
)

data class BackupResult(val ok: Boolean, val path: String = "", val message: String = "")

data class SkillInfo(
  val id: String,
  val name: String,
  val description: String = "",
  val enabled: Boolean = true
)

data class MemoryInfo(
  val enabled: Boolean = false,
  val provider: String = "",
  val summary: String = "",
  val entries: Int = 0
)

data class CommandInfo(val name: String, val description: String = "")
