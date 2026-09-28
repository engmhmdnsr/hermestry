package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.ToolExecution
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/** Emoji per tool family, mirroring Hermes Control's getToolIcon. */
fun toolIcon(toolName: String): String {
    val n = toolName.lowercase()
    return when {
        n.contains("terminal") || n.contains("exec") || n.contains("shell") || n.contains("bash") -> "⌨️"
        n.contains("read") || n.contains("cat") || n.contains("file") -> "📄"
        n.contains("write") || n.contains("edit") || n.contains("patch") || n.contains("apply") -> "✏️"
        n.contains("search") || n.contains("grep") || n.contains("find") || n.contains("glob") -> "🔍"
        n.contains("web") || n.contains("fetch") || n.contains("curl") || n.contains("http") -> "🌐"
        n.contains("browser") || n.contains("screenshot") -> "🖥️"
        n.contains("git") || n.contains("commit") || n.contains("diff") || n.contains("pr") -> "🌿"
        n.contains("test") || n.contains("pytest") || n.contains("jest") -> "🧪"
        n.contains("build") || n.contains("compile") || n.contains("gradle") -> "🔨"
        n.contains("memory") || n.contains("recall") || n.contains("note") -> "🧠"
        n.contains("skill") -> "🧩"
        n.contains("image") || n.contains("vision") || n.contains("camera") -> "🖼️"
        n.contains("audio") || n.contains("tts") || n.contains("speech") -> "🔊"
        else -> "🔧"
    }
}

private fun toolStatusColor(status: String): Color = when (status.lowercase()) {
    "running", "started", "pending" -> NeonCyan
    "failed", "error" -> NeonRed
    else -> TextSecondary
}

private fun toolPreview(tool: ToolExecution, maxLen: Int = 40): String {
    val raw = tool.output.ifBlank { tool.command }.replace('\n', ' ').trim()
    return if (raw.length <= maxLen) raw else raw.take(maxLen) + "…"
}

@Composable
fun CompactToolLine(
    tool: ToolExecution,
    modifier: Modifier = Modifier,
    fontScale: Float = 1f
) {
    Row(
        modifier.fillMaxWidth().padding(vertical = 2.dp)
    ) {
        Text(
            toolIcon(tool.toolName),
            fontSize = (12 * fontScale).sp
        )
        Spacer(Modifier.width(6.dp))
        Text(
            tool.toolName,
            color = TextPrimary, fontSize = (12 * fontScale).sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(6.dp))
        Text(
            tool.status,
            color = toolStatusColor(tool.status), fontSize = (11 * fontScale).sp,
            fontFamily = FontFamily.Monospace
        )
        val preview = toolPreview(tool)
        if (preview.isNotBlank()) {
            Spacer(Modifier.width(6.dp))
            Text(
                preview,
                color = TextSecondary, fontSize = (11 * fontScale).sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
fun ToolExecutionsBlock(
    tools: List<ToolExecution>,
    isStreaming: Boolean,
    modifier: Modifier = Modifier,
    fontScale: Float = 1f
) {
    if (tools.isEmpty()) return
    Column(modifier.fillMaxWidth()) {
        if (isStreaming) {
            tools.forEach { CompactToolLine(it, fontScale = fontScale) }
        } else {
            var expanded by rememberSaveable { mutableStateOf(false) }
            Row(
                Modifier.fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(vertical = 4.dp)
            ) {
                Text(
                    (if (expanded) "▾ " else "▸ ") + "${tools.size} tools",
                    color = TextSecondary, fontSize = (12 * fontScale).sp,
                    fontFamily = FontFamily.Monospace
                )
            }
            if (expanded) {
                tools.forEach { CompactToolLine(it, fontScale = fontScale) }
                Spacer(Modifier.height(2.dp))
            }
        }
    }
}
