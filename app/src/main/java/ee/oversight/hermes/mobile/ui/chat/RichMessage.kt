package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.CyberTerminalBg
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

@Composable
fun CodeBlock(code: String, language: String = "", scale: Float = 1f) {
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier.fillMaxWidth()
            .background(CyberTerminalBg, RoundedCornerShape(8.dp))
            .padding(8.dp)
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                language.ifBlank { "code" },
                color = NeonCyan, fontSize = (11 * scale).sp,
                fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { clipboard.setText(AnnotatedString(code)) }) {
                Text("Copy", color = NeonCyan, fontSize = (11 * scale).sp)
            }
        }
        Text(
            code, color = TextPrimary, fontSize = (12 * scale).sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.horizontalScroll(rememberScrollState())
        )
    }
}

@Composable
fun DiffBlock(diff: String, scale: Float = 1f) {
    val clipboard = LocalClipboardManager.current
    val scroll = rememberScrollState()
    Column(
        Modifier.fillMaxWidth()
            .background(CyberTerminalBg, RoundedCornerShape(8.dp))
            .padding(8.dp)
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                "diff",
                color = NeonCyan, fontSize = (11 * scale).sp,
                fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { clipboard.setText(AnnotatedString(diff)) }) {
                Text("Copy", color = NeonCyan, fontSize = (11 * scale).sp)
            }
        }
        Column(Modifier.horizontalScroll(scroll)) {
            diff.lines().forEach { line ->
                val color = when {
                    line.startsWith("+") && !line.startsWith("+++") -> NeonGreen
                    line.startsWith("-") && !line.startsWith("---") -> NeonRed
                    else -> TextSecondary
                }
                Text(
                    line.ifBlank { " " }, color = color, fontSize = (12 * scale).sp,
                    fontFamily = FontFamily.Monospace
                )
            }
        }
    }
}

@Composable
fun TermBlock(output: String, scale: Float = 1f) {
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier.fillMaxWidth()
            .background(CyberSurfaceElevated, RoundedCornerShape(8.dp))
            .padding(8.dp)
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                "output",
                color = NeonCyan, fontSize = (11 * scale).sp,
                fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { clipboard.setText(AnnotatedString(output)) }) {
                Text("Copy", color = NeonCyan, fontSize = (11 * scale).sp)
            }
        }
        Text(
            output, color = TextPrimary, fontSize = (12 * scale).sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.horizontalScroll(rememberScrollState())
        )
    }
}

@Composable
fun Collapsible(title: String, scale: Float = 1f, content: @Composable () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp)) {
            Text(
                (if (open) "▾ " else "▸ ") + title,
                color = TextSecondary, fontSize = (12 * scale).sp,
                fontFamily = FontFamily.Monospace
            )
        }
        if (open) content()
    }
}

@Composable
fun renderRichText(content: String, scale: Float = 1f) {
    val parts = content.split("```")
    if (parts.size == 1) {
        Text(content, color = TextPrimary, fontSize = (14 * scale).sp)
        return
    }
    // Even part count means the trailing fence never closed: the last
    // segment is plain prose, not code.
    val unclosed = parts.size % 2 == 0
    val body = if (unclosed) parts.dropLast(1) else parts
    val tail = if (unclosed) parts.last() else ""
    body.forEachIndexed { i, part ->
        if (i % 2 == 0) {
            if (part.isNotBlank()) {
                Text(part.trim(), color = TextPrimary, fontSize = (14 * scale).sp)
                Spacer(Modifier.height(4.dp))
            }
        } else {
            val nl = part.indexOf('\n')
            val lang = if (nl < 0) part.trim() else part.substring(0, nl).trim()
            val code = if (nl < 0) "" else part.substring(nl + 1).trimEnd()
            // Empty fence renders nothing: no empty CodeBlock.
            if (code.isBlank()) return@forEachIndexed
            if (lang == "diff") DiffBlock(code, scale)
            else if (lang == "term" || lang == "terminal" || lang == "output") TermBlock(code, scale)
            else if (code.length > 1200) Collapsible(lang.ifBlank { "output" }, scale) { CodeBlock(code, lang, scale) }
            else CodeBlock(code, lang, scale)
            Spacer(Modifier.height(4.dp))
        }
    }
    if (tail.isNotBlank()) {
        Text(tail.trim(), color = TextPrimary, fontSize = (14 * scale).sp)
    }
}
