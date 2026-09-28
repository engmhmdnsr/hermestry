package ee.oversight.hermes.mobile.model

data class ToolExecution(
  val id: String,
  val toolName: String,
  val command: String = "",
  val output: String = "",
  val status: String = "running",
  val exitCode: Int? = null,
  val executionTimeMs: Long? = null
)

data class ChatMessageV2(
  val id: String,
  val sender: String,
  val content: String,
  val timestamp: Long = 0L,
  val modelName: String = "",
  val isStreaming: Boolean = false,
  val attachments: List<String> = emptyList(),
  val thinkingContent: String = "",
  val thinkingDone: Boolean = false,
  val tools: List<ToolExecution> = emptyList()
)

data class AiModelInfoV2(
  val id: String,
  val displayName: String,
  val provider: String = "",
  val description: String = ""
)

/** Legacy [ChatMessage.tools] entries become completed [ToolExecution] blocks keyed by tool name. */
fun ChatMessage.toV2(): ChatMessageV2 = ChatMessageV2(
  id = id,
  sender = sender,
  content = content,
  thinkingContent = thinking,
  thinkingDone = thinkingDone,
  tools = tools.map { name -> ToolExecution(id = name, toolName = name, status = "completed") }
)

/** V2 tools collapse back to legacy tool-name strings. */
fun ChatMessageV2.toLegacy(): ChatMessage = ChatMessage(
  id = id,
  sender = sender,
  content = content,
  thinking = thinkingContent,
  thinkingDone = thinkingDone,
  tools = tools.map { it.toolName }
)
