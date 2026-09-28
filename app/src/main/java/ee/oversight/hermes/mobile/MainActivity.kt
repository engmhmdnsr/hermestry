package ee.oversight.hermes.mobile

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.BuildConfig
import ee.oversight.hermes.mobile.model.ChatMessage
import ee.oversight.hermes.mobile.model.MobileSession
import ee.oversight.hermes.mobile.ui.theme.CyberBg
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.CyberTerminalBg
import ee.oversight.hermes.mobile.ui.theme.HermesMobileTheme
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.NeonVioletDark
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import ee.oversight.hermes.mobile.R
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.components.TtsSpeaker
import ee.oversight.hermes.mobile.ui.chat.MessageFooter
import ee.oversight.hermes.mobile.ui.chat.ThinkingBlock
import ee.oversight.hermes.mobile.ui.chat.ModelsSheet
import ee.oversight.hermes.mobile.ui.chat.ChatSearchBar
import ee.oversight.hermes.mobile.ui.chat.ChatSearchButton
import ee.oversight.hermes.mobile.ui.chat.StreamingControls
import ee.oversight.hermes.mobile.ui.chat.QueuedBanner
import ee.oversight.hermes.mobile.ui.chat.AgentHeader
import ee.oversight.hermes.mobile.ui.chat.SenderLabel
import ee.oversight.hermes.mobile.ui.chat.WorkspaceToolCard
import ee.oversight.hermes.mobile.ui.chat.ProminentApprovalCard
import ee.oversight.hermes.mobile.ui.chat.WorkspaceEmptyState
import ee.oversight.hermes.mobile.ui.chat.TurnErrorBanner
import ee.oversight.hermes.mobile.ui.chat.filterMessages
import ee.oversight.hermes.mobile.model.AiModelInfoV2
import ee.oversight.hermes.mobile.model.ToolExecution
import ee.oversight.hermes.mobile.ui.chat.renderRichText
import ee.oversight.hermes.mobile.ui.chat.MessageActionsRow
import ee.oversight.hermes.mobile.ui.chat.ChatFontScale
import ee.oversight.hermes.mobile.ui.chat.loadChatFontScale
import ee.oversight.hermes.mobile.ui.chat.loadReasoningEffort
import ee.oversight.hermes.mobile.ui.more.VersionDetailsCard
import ee.oversight.hermes.mobile.ui.more.FeedbackForm
import ee.oversight.hermes.mobile.install.classifyBootError
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.ui.security.AppLockSession
import ee.oversight.hermes.mobile.ui.chat.ReasoningEffort
import ee.oversight.hermes.mobile.ui.chat.AutoApproveState
import ee.oversight.hermes.mobile.ui.chat.AutoApprovePill
import ee.oversight.hermes.mobile.ui.security.AppLockPrefs
import ee.oversight.hermes.mobile.ui.security.AppLockGate
import ee.oversight.hermes.mobile.ui.chat.VoiceInputButton
import ee.oversight.hermes.mobile.ui.chat.SlashCatalog
import ee.oversight.hermes.mobile.ui.chat.CommandPillsRow
import ee.oversight.hermes.mobile.ui.chat.SlashCommand
import ee.oversight.hermes.mobile.ui.chat.DraftStore
import ee.oversight.hermes.mobile.ui.chat.JumpToBottom
import ee.oversight.hermes.mobile.ui.sessions.SessionSearchBar
import ee.oversight.hermes.mobile.ui.sessions.RenameDialog
import ee.oversight.hermes.mobile.ui.sessions.SessionRowActions
import ee.oversight.hermes.mobile.ui.sessions.SessionPinStore
import ee.oversight.hermes.mobile.ui.sessions.PinnedSection
import ee.oversight.hermes.mobile.ui.sessions.exportSessionMarkdown
import ee.oversight.hermes.mobile.ui.more.AboutScreen
import ee.oversight.hermes.mobile.ui.more.NotifCenter
import ee.oversight.hermes.mobile.ui.more.SkillsScreen
import ee.oversight.hermes.mobile.ui.more.MemoryScreen
import ee.oversight.hermes.mobile.ui.more.BlueprintLaunchCard
import ee.oversight.hermes.mobile.ui.more.BlueprintsDialog
import ee.oversight.hermes.mobile.ui.settings.SettingsRoot
import ee.oversight.hermes.mobile.ui.home.HomeTab
import ee.oversight.hermes.mobile.ui.system.OpsPanel
import ee.oversight.hermes.mobile.network.GatewayClient
import ee.oversight.hermes.mobile.service.MobileGatewayService
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import ee.oversight.hermes.mobile.ui.theme.TextTerminal
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.input.ImeAction
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    val vm = (application as MobileApp).vm
    setContent { HermesMobileTheme { App(vm) } }
  }
}

@Composable
fun App(vm: MobileViewModel) {
  val context = LocalContext.current
  var onboarded by remember { mutableStateOf(vm.isOnboarded()) }
  var unlocked by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    ChatFontScale.value = loadChatFontScale(context)
    AutoApproveState.global = AutoApproveState.loadGlobal(context)
    ReasoningEffort.selected.value = loadReasoningEffort(context)
  }
  if (!onboarded) {
    OnboardingWizard(vm, onDone = {
      vm.setOnboarded()
      onboarded = true
    })
  } else if (AppLockPrefs.isEnabled(context) && !unlocked) {
    // Policy: auto-approve stays paused while the lock gate wraps content.
    // The VM reads AutoApproveState.global every poll, so clearing it here
    // (memory-only) pauses auto-resolve until onUnlocked restores it.
    LaunchedEffect(Unit) {
      AppLockSession.locked = true
      AppLockSession.suppressAutoApprove()
    }
    AppLockGate(onUnlocked = {
      AppLockSession.locked = false
      AppLockSession.restoreAutoApprove()
      unlocked = true
    })
  } else {
    MainScaffold(vm)
  }
}

// ── First-run wizard: welcome → install → keys → started ──

/** Registry api-key provider ids (hermes_cli/auth.py) + local aliases.
 *  Anything else is a named-custom provider and must bring a base URL. */
/** Full API-key provider catalog, mirrored from Desktop hermes_cli/auth.py
 *  PROVIDER_REGISTRY (OAuth / external-process / AWS-SDK rows excluded:
 *  they cannot work with a pasted key on a phone). */
val PROVIDER_OPTIONS = listOf(
  "deepseek" to "DeepSeek",
  "opencode-go" to "OpenCode Go",
  "opencode-zen" to "OpenCode Zen",
  "openai-api" to "OpenAI API",
  "anthropic" to "Anthropic",
  "gemini" to "Google AI Studio",
  "xai" to "xAI",
  "kimi-coding" to "Kimi / Moonshot",
  "kimi-coding-cn" to "Kimi / Moonshot (China)",
  "zai" to "Z.AI / GLM",
  "minimax" to "MiniMax",
  "minimax-cn" to "MiniMax (China)",
  "alibaba" to "Qwen Cloud",
  "alibaba-coding-plan" to "Alibaba Cloud (Coding Plan)",
  "nvidia" to "NVIDIA NIM",
  "ai-gateway" to "Vercel AI Gateway",
  "kilocode" to "Kilo Code",
  "huggingface" to "Hugging Face",
  "xiaomi" to "Xiaomi MiMo",
  "tencent-tokenhub" to "Tencent TokenHub",
  "tencent-tokenplan" to "Tencent TokenPlan",
  "ollama-cloud" to "Ollama Cloud",
  "lmstudio" to "LM Studio",
  "copilot" to "GitHub Copilot",
  "stepfun" to "StepFun Step Plan",
  "arcee" to "Arcee AI",
  "gmi" to "GMI Cloud",
  "actual" to "Actual Computer",
  "azure-foundry" to "Azure Foundry"
)

/** Desktop _PROVIDER_ALIASES (api-key rows only) so typed shorthands resolve. */
val PROVIDER_ALIASES = mapOf(
  "glm" to "zai", "z-ai" to "zai", "z.ai" to "zai", "zhipu" to "zai",
  "google" to "gemini", "google-gemini" to "gemini", "google-ai-studio" to "gemini",
  "x-ai" to "xai", "x.ai" to "xai", "grok" to "xai",
  "kimi" to "kimi-coding", "kimi-for-coding" to "kimi-coding", "moonshot" to "kimi-coding",
  "kimi-cn" to "kimi-coding-cn", "moonshot-cn" to "kimi-coding-cn",
  "step" to "stepfun", "stepfun-coding-plan" to "stepfun",
  "arcee-ai" to "arcee", "arceeai" to "arcee",
  "gmi-cloud" to "gmi", "gmicloud" to "gmi",
  "actual-computer" to "actual", "actualcomputer" to "actual", "aci" to "actual",
  "minimax-china" to "minimax-cn", "minimax_cn" to "minimax-cn",
  "alibaba_coding" to "alibaba-coding-plan", "alibaba-coding" to "alibaba-coding-plan",
  "alibaba_coding_plan" to "alibaba-coding-plan",
  "claude" to "anthropic", "claude-code" to "anthropic",
  "github" to "copilot", "github-copilot" to "copilot",
  "github-models" to "copilot", "github-model" to "copilot",
  "aigateway" to "ai-gateway", "vercel" to "ai-gateway", "vercel-ai-gateway" to "ai-gateway",
  "opencode" to "opencode-zen", "zen" to "opencode-zen",
  "hf" to "huggingface", "hugging-face" to "huggingface", "huggingface-hub" to "huggingface",
  "mimo" to "xiaomi", "xiaomi-mimo" to "xiaomi",
  "tencent" to "tencent-tokenhub", "tokenhub" to "tencent-tokenhub",
  "tencent-cloud" to "tencent-tokenhub", "tencentmaas" to "tencent-tokenhub",
  "tokenplan" to "tencent-tokenplan", "tencent-lkeap" to "tencent-tokenplan",
  "go" to "opencode-go", "opencode-go-sub" to "opencode-go",
  "kilo" to "kilocode", "kilo-code" to "kilocode", "kilo-gateway" to "kilocode",
  "lm-studio" to "lmstudio", "lm_studio" to "lmstudio"
)

val KNOWN_PROVIDERS: Set<String> = PROVIDER_OPTIONS.map { it.first }.toSet()

/** Normalize typed provider ids: trim, lowercase, whitespace -> dash, aliases -> canonical.
 *  So "OpenCode GO" / "opencode go" / "go" all resolve to "opencode-go". */
fun normProvider(p: String): String {
  val slug = p.trim().lowercase().replace(Regex("\\s+"), "-")
  return PROVIDER_ALIASES[slug] ?: slug
}

/** Dropdown picker over the Desktop provider catalog + custom-id fallback. */
@Composable
fun ProviderPicker(value: String, onChange: (String) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  val normed = normProvider(value)
  var custom by remember(value) {
    mutableStateOf(value.isNotBlank() && normed !in KNOWN_PROVIDERS)
  }
  if (!custom) {
    val current = PROVIDER_OPTIONS.firstOrNull { it.first == normed }
    Box(Modifier.fillMaxWidth()) {
      OutlinedTextField(
        value = current?.let { "${it.second} (${it.first})" } ?: "",
        onValueChange = {},
        readOnly = true,
        label = { Text("provider") },
        placeholder = { Text("pick a provider…") },
        trailingIcon = {
          IconButton(onClick = { expanded = true }) {
            Icon(Icons.Filled.ArrowDropDown, contentDescription = "pick provider",
              tint = TextSecondary)
          }
        },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        colors = OutlinedTextFieldDefaults.colors(
          focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
          focusedBorderColor = NeonViolet, unfocusedBorderColor = CyberSurfaceElevated,
          focusedLabelColor = NeonVioletLight, unfocusedLabelColor = TextSecondary)
      )
      // Transparent tap layer: whole field opens the menu, not just the chevron.
      Box(Modifier.matchParentSize().clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null) { expanded = true })
      DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        PROVIDER_OPTIONS.forEach { (id, name) ->
          DropdownMenuItem(
            text = { Text("$name ($id)", fontSize = 14.sp) },
            onClick = { onChange(id); expanded = false }
          )
        }
        DropdownMenuItem(
          text = { Text("Custom… (base URL)", fontSize = 14.sp, color = NeonCyan) },
          onClick = { custom = true; onChange(""); expanded = false }
        )
      }
    }
    Spacer(Modifier.height(8.dp))
  } else {
    WizardField(value, onChange, "custom provider id")
    Row(verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Text("a custom base URL below is required",
        color = NeonAmber, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
      Spacer(Modifier.weight(1f))
      TextButton(onClick = { custom = false; onChange("deepseek") }) {
        Text("← back to list", color = NeonCyan, fontSize = 12.sp)
      }
    }
    Spacer(Modifier.height(8.dp))
  }
}

/** Shared gate: wizard step 2 AND ConnSection use the same rule. */
fun keysValid(provider: String, key: String, baseUrl: String): Boolean {
  if (key.isBlank()) return false
  val p = normProvider(provider).ifBlank { "deepseek" }
  return p in KNOWN_PROVIDERS || baseUrl.isNotBlank()
}

/** Tiny toast wrapper for save/confirm feedback in Setup + wizard. */
fun toast(ctx: Context, msg: String) {
  Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
}

@Composable
fun OnboardingWizard(vm: MobileViewModel, onDone: () -> Unit) {
  val install by vm.install.collectAsState()
  val connected by vm.connected.collectAsState()
  var step by remember {
    mutableIntStateOf(if (install == InstallState.INSTALLED) 2 else 0)
  }

  // gateway live → wizard done (keyed on both: connect may predate step 3)
  LaunchedEffect(connected, step) {
    if (connected && step == 3) onDone()
  }

  Column(
    Modifier.fillMaxSize().background(CyberBg)
      .statusBarsPadding().navigationBarsPadding().imePadding().padding(24.dp)
      .verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.Top
  ) {
    Text("// HERMES MOBILE", color = NeonCyan, fontSize = 12.sp,
      fontFamily = FontFamily.Monospace)
    Text(
      when (step) {
        0 -> "On-phone Hermes"
        1 -> "Step 1/3 · Install"
        2 -> "Step 2/3 · Your keys"
        else -> "Step 3/3 · Start"
      },
      color = TextPrimary, fontSize = 26.sp, fontWeight = FontWeight.Bold
    )
    Spacer(Modifier.height(6.dp))
    StepDots(step, 4)
    Spacer(Modifier.height(18.dp))

    when (step) {
      0 -> {
        val installArch = Bootstrap.arch()
        Text(
          "This app installs a real Hermes gateway ON your phone. No Termux, no PC needed.\n\n" +
            "First it downloads the prebuilt image (~305MB, Debian + Python + hermes-agent ready). One time, then it just runs. " +
            "Your API keys come after the download finishes." +
            if (installArch != "aarch64") "\n\nNote: the prebuilt image is arm64-only, install on $installArch is experimental." else "",
          color = TextSecondary, fontSize = 14.sp
        )
        Spacer(Modifier.height(24.dp))
        WizardButton("Start install", { step = 1 })
      }
      1 -> {
        val progress by vm.progress.collectAsState()
        val appLog by vm.log.collectAsState()
        val stepArch = Bootstrap.arch()
        LaunchedEffect(Unit) {
          if (vm.install.value == InstallState.NOT_INSTALLED) vm.install()
        }
        Text(
          when (install) {
            InstallState.INSTALLING -> "Downloading and installing... keep the app open." +
              if (stepArch != "aarch64") " (experimental support for $stepArch)" else ""
            InstallState.INSTALLED -> "Download complete. Next: your keys."
            InstallState.FAILED -> "Install failed. See details below and retry."
            else -> "Preparing installer..."
          },
          color = TextSecondary, fontSize = 14.sp
        )
        Spacer(Modifier.height(12.dp))
        if (install == InstallState.INSTALLING) {
          LinearProgressIndicator(Modifier.fillMaxWidth(), color = NeonViolet,
            trackColor = CyberSurfaceElevated)
          Spacer(Modifier.height(8.dp))
        }
        if (progress.isNotBlank()) Text(progress, color = NeonCyan, fontSize = 12.sp,
          fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(8.dp))
        LogBox(appLog.takeLast(15))
        Spacer(Modifier.height(24.dp))
        if (install == InstallState.INSTALLED) {
          WizardButton("Continue", { step = 2 })
        } else if (install == InstallState.NOT_INSTALLED || install == InstallState.FAILED) {
          // Install FAILED banner (VM owns InstallState.FAILED + installError).
          val failMsg by vm.installError.collectAsState()
          if (install == InstallState.FAILED && failMsg != null) {
            Text("Install failed: $failMsg", color = NeonRed, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(8.dp))
          }
          WizardButton("Retry install", { vm.install() })
          // Any failure state (not just an install-FAILED line): after a
          // failed attempt the log holds something worth classifying +
          // exporting, so always show the classifier + export when the log
          // is non-empty.
          if (appLog.isNotEmpty()) {
            val bootError = remember(appLog) { classifyBootError(appLog) }
            Spacer(Modifier.height(8.dp))
            Text(bootError.userLine, color = NeonAmber, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace)
            Text(bootError.suggestedAction, color = TextSecondary, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
              onClick = { vm.exportLog().let { vm.addLogPublic(it) } },
              modifier = Modifier.fillMaxWidth()
            ) { Text("Export log to Download", color = NeonCyan) }
          }
        }
      }
      2 -> {
        var provider by remember { mutableStateOf(vm.provider()) }
        var key by remember { mutableStateOf(vm.apiKey()) }
        var model by remember { mutableStateOf(vm.modelId()) }
        var baseUrl by remember { mutableStateOf(vm.baseUrl()) }
        var tg by remember { mutableStateOf(vm.tgToken()) }
        val needBase = normProvider(provider).ifBlank { "deepseek" } !in KNOWN_PROVIDERS
        Text("Download is done. Now enter your keys (stored only on this phone).",
          color = TextSecondary, fontSize = 14.sp)
        Spacer(Modifier.height(12.dp))
        ProviderPicker(provider) { provider = it }
        WizardField(key, { key = it }, "provider API key *")
        WizardField(model, { model = it }, "model id (optional)")
        WizardField(baseUrl, { baseUrl = it }, "base URL (only for custom endpoints)")
        WizardField(tg, { tg = it }, "telegram bot token (separate bot!)")
        Spacer(Modifier.height(8.dp))
        if (key.isBlank()) Text("API key is required to continue.",
          color = NeonAmber, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        else if (needBase && baseUrl.isBlank()) Text(
          "Unknown provider: a custom base URL is required (it is not a built-in).",
          color = NeonAmber, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(12.dp))
        WizardButton(
          "Save and continue", {
            vm.saveKeys(provider, key, model, baseUrl, tg, vm.discordToken(), vm.serverKey(), vm.autostart())
            step = 3
          },
          enabled = keysValid(provider, key, baseUrl)
        )
      }
      3 -> {
        var startTick by remember { mutableIntStateOf(0) }
        // One-time boot-restart consent: autostart defaults off and nothing
        // else asks, so step 3 shows the real value and offers Enable/Skip.
        val needConsent by vm.needAutostartConsent.collectAsState()
        var bootRestart by remember { mutableStateOf(vm.autostart()) }
        Text("Start the on-phone gateway. It stays running in the background" +
          if (bootRestart) " and restarts on boot."
          else " (boot restart is currently off).",
          color = TextSecondary, fontSize = 14.sp)
        Spacer(Modifier.height(12.dp))
        if (needConsent) {
          Card(colors = CardDefaults.cardColors(containerColor = CyberSurface),
            modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
              Text("Restart Hermes on boot?",
                color = TextPrimary, fontSize = 14.sp,
                fontWeight = FontWeight.Bold)
              Spacer(Modifier.height(4.dp))
              Text("With this on, the gateway starts automatically after " +
                "a reboot. It stays off unless you enable it here.",
                color = TextSecondary, fontSize = 12.sp)
              Spacer(Modifier.height(8.dp))
              Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                  onClick = { vm.setAutostart(true); bootRestart = true },
                  colors = ButtonDefaults.buttonColors(
                    containerColor = NeonViolet, contentColor = Color.White),
                  modifier = Modifier.weight(1f)
                ) { Text("Enable") }
                OutlinedButton(
                  onClick = { vm.setAutostart(false); bootRestart = false },
                  modifier = Modifier.weight(1f)
                ) { Text("Skip") }
              }
            }
          }
          Spacer(Modifier.height(12.dp))
        } else {
          Text("Boot restart: " + if (bootRestart) "ON" else "OFF" +
            " (change it in Settings).",
            color = TextSecondary, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace)
          Spacer(Modifier.height(12.dp))
        }
        Spacer(Modifier.height(24.dp))
        WizardButton("Start Hermes", {
          startTick++
          vm.start()
        }, enabled = install == InstallState.INSTALLED || install == InstallState.RUNNING)
        Spacer(Modifier.height(8.dp))
        if (install == InstallState.RUNNING && !connected) {
          Text("starting... waiting for localhost:8080", color = NeonAmber,
            fontSize = 12.sp, fontFamily = FontFamily.Monospace)
          if (startTick > 0) {
            var waited by remember(startTick) { mutableIntStateOf(0) }
            LaunchedEffect(startTick) {
              while (waited < 90) { kotlinx.coroutines.delay(1000); waited++ }
            }
            if (waited >= 90) Text(
              "still not up after 90s: skip below, then open the System tab and check the gateway log.",
              color = NeonAmber, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
          }
        }
        // Escape hatch: the wizard waits for a live gateway, but the log
        // viewer lives in the main UI. Skipping loses nothing: Setup has Start.
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = onDone) {
          Text("Skip for now, open the app", color = TextSecondary, fontSize = 13.sp)
        }
      }
    }
  }
}

/** Live terminal-style log box, follows new lines as they arrive. */
@Composable
fun LogBox(lines: List<String>) {
  val state = rememberLazyListState()
  LaunchedEffect(lines.size) {
    if (lines.isNotEmpty()) state.scrollToItem(lines.size - 1)
  }
  Card(colors = CardDefaults.cardColors(containerColor = CyberTerminalBg),
    modifier = Modifier.fillMaxWidth()) {
    LazyColumn(state = state,
      modifier = Modifier.padding(10.dp).heightIn(min = 120.dp, max = 220.dp),
      verticalArrangement = Arrangement.spacedBy(2.dp)) {
      items(lines) {
        Text(it, color = TextTerminal, fontSize = 11.sp,
          fontFamily = FontFamily.Monospace)
      }
    }
  }
}

@Composable
fun StepDots(step: Int, total: Int) {
  Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    repeat(total) { i ->
      Box(Modifier.width(28.dp).height(4.dp).background(
        if (i <= step) NeonViolet else CyberSurfaceElevated))
    }
  }
}

@Composable
fun WizardButton(text: String, onClick: () -> Unit, enabled: Boolean = true) {
  Button(
    onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth(),
    colors = ButtonDefaults.buttonColors(containerColor = NeonViolet,
      contentColor = Color.White, disabledContainerColor = CyberSurfaceElevated)
  ) { Text(text, fontSize = 15.sp) }
}

@Composable
fun WizardField(value: String, onChange: (String) -> Unit, label: String) {
  OutlinedTextField(
    value, onChange, label = { Text(label) }, modifier = Modifier.fillMaxWidth(),
    singleLine = true,
    colors = OutlinedTextFieldDefaults.colors(
      focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
      focusedBorderColor = NeonViolet, unfocusedBorderColor = CyberSurfaceElevated,
      focusedLabelColor = NeonVioletLight, unfocusedLabelColor = TextSecondary)
  )
  Spacer(Modifier.height(8.dp))
}

// ── Main app (Control identity) ──

/** Compact token count: 1500 -> 1.5k, 2000000 -> 2.0M. */
fun fmtTok(n: Long): String = when {
  n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
  n >= 1_000 -> "%.1fk".format(n / 1_000.0)
  else -> "$n"
}

@Composable
fun MainScaffold(vm: MobileViewModel) {
  var tab by remember { mutableIntStateOf(0) }
  val install by vm.install.collectAsState()
  val connected by vm.connected.collectAsState()
  val usageIn by vm.usageIn.collectAsState()
  val usageOut by vm.usageOut.collectAsState()
  val drawer = rememberDrawerState(DrawerValue.Closed)
  val scope = rememberCoroutineScope()
  val sessions by vm.sessions.collectAsState()
  var filter by remember { mutableStateOf("") }
  var renameTarget by remember { mutableStateOf<MobileSession?>(null) }
  var pendingSessionDelete by remember { mutableStateOf<MobileSession?>(null) }
  val ctx = LocalContext.current
  var pinnedIds by remember { mutableStateOf(SessionPinStore.getPinnedIds(ctx)) }
  var sourceFilter by remember { mutableStateOf("ALL") }
  var sortMode by remember { mutableIntStateOf(0) } // 0 newest, 1 oldest, 2 most msgs
  val currentId by vm.currentSessionId.collectAsState()
  val chatMsgs by vm.chat.collectAsState()
  val approvalsTop by vm.approvals.collectAsState()
  // Only sources actually present (blank server source shown as "unknown").
  val presentSources = remember(sessions) {
    sessions.map { it.source.ifBlank { "unknown" } }.distinct().sorted()
  }
  val visible = remember(sessions, filter, sourceFilter, sortMode) {
    var l = sessions.filter {
      (filter.isBlank() ||
        it.title.contains(filter, ignoreCase = true) ||
        it.id.contains(filter, ignoreCase = true)) &&
      (sourceFilter == "ALL" || it.source.ifBlank { "unknown" } == sourceFilter)
    }
    l = when (sortMode) {
      1 -> l.sortedBy { it.lastActiveAt }
      2 -> l.sortedByDescending { it.messageCount }
      else -> l.sortedByDescending { it.lastActiveAt }
    }
    l
  }

  LaunchedEffect(install) {
    if (install == InstallState.RUNNING) vm.refreshNow()
    else if (install == InstallState.INSTALLED) vm.coldStart()
  }

  ModalNavigationDrawer(
    drawerState = drawer,
    drawerContent = {
      Column(Modifier.fillMaxWidth(0.85f).background(CyberSurface)
        .padding(12.dp).fillMaxSize()) {
        Row(Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically) {
          Text("SESSIONS", color = TextSecondary, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace)
          Row {
            IconButton(onClick = {
              val sid = currentId ?: return@IconButton
              val sess = sessions.firstOrNull { it.id == sid }
              val full = exportSessionMarkdown(sess?.title ?: "untitled", sid, chatMsgs)
              // Binder EXTRA_TEXT cap: truncate very long transcripts.
              val md = if (full.length > 100_000)
                full.take(100_000) + "\n\n...[truncated ${full.length - 100_000} chars]..."
              else full
              val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, md)
              }
              ctx.startActivity(Intent.createChooser(send, "Share session"))
            }) {
              Icon(Icons.Filled.Share, "export", tint = TextSecondary)
            }
            IconButton(onClick = { vm.newSession() }) {
              Icon(Icons.Filled.Add, "new", tint = NeonViolet)
            }
            IconButton(onClick = { scope.launch { vm.refreshNow() } }) {
              Icon(Icons.Filled.Refresh, "refresh", tint = TextSecondary)
            }
          }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          item {
            SessionSearchBar(query = filter, onQueryChange = { filter = it })
          }
          if (presentSources.size > 1) {
            item {
              Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf("ALL").plus(presentSources).forEach { src ->
                  TextButton(onClick = { sourceFilter = src }) {
                    Text(src.uppercase(), fontSize = 10.sp,
                      fontFamily = FontFamily.Monospace,
                      color = if (sourceFilter == src) NeonCyan else TextSecondary)
                  }
                }
              }
            }
          }
          item {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Text("SORT:", color = TextSecondary, fontSize = 10.sp,
                fontFamily = FontFamily.Monospace)
              listOf("NEWEST" to 0, "OLDEST" to 1, "MOST MSGS" to 2).forEach { (label, mode) ->
                TextButton(onClick = { sortMode = mode }) {
                  Text(label, fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    color = if (sortMode == mode) NeonCyan else TextSecondary)
                }
              }
            }
          }
          if (sessions.isEmpty()) {
            item {
              Column(Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No sessions yet — start your first chat",
                  color = TextSecondary, fontSize = 13.sp)
                TextButton(onClick = { vm.newSession() }) {
                  Text("+ NEW SESSION", color = NeonCyan, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace)
                }
              }
            }
          } else if (visible.isEmpty()) {
            item {
              Column(Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No sessions match the current filters",
                  color = TextSecondary, fontSize = 13.sp)
                TextButton(onClick = { filter = ""; sourceFilter = "ALL" }) {
                  Text("CLEAR FILTERS", color = NeonCyan, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace)
                }
              }
            }
          } else {
            item {
              PinnedSection(
                sessions = visible,
                pinnedIds = pinnedIds,
                onTogglePin = { sess ->
                  SessionPinStore.toggle(ctx, sess.id)
                  pinnedIds = SessionPinStore.getPinnedIds(ctx)
                }
              ) { s, isPinned, onTogglePin ->
            Card(
              colors = CardDefaults.cardColors(containerColor = CyberSurfaceElevated),
              modifier = Modifier.fillMaxWidth().clickable {
                vm.selectSession(s.id)
                scope.launch { drawer.close() }
                tab = 1
              }
            ) {
              Column(Modifier.padding(10.dp)) {
                Row(Modifier.fillMaxWidth(),
                  horizontalArrangement = Arrangement.SpaceBetween,
                  verticalAlignment = Alignment.CenterVertically) {
                  Text(s.title.ifBlank { "untitled" }, color = TextPrimary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp,
                    modifier = Modifier.weight(1f))
                  IconButton(onClick = onTogglePin, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Filled.Star, if (isPinned) "unpin" else "pin",
                      tint = if (isPinned) NeonAmber else TextSecondary,
                      modifier = Modifier.size(16.dp))
                  }
                }
                Text("${s.messageCount} msgs", color = TextSecondary, fontSize = 11.sp,
                  fontFamily = FontFamily.Monospace)
                Row(verticalAlignment = Alignment.CenterVertically) {
                  SessionRowActions(
                    sessionId = s.id,
                    onRename = { id ->
                      renameTarget = sessions.firstOrNull { it.id == id }
                    },
                    onFork = { vm.forkSession(it) }
                  )
                  TextButton(onClick = { pendingSessionDelete = s }) {
                    Text("Delete", color = NeonRed, fontSize = 12.sp)
                  }
                }
              }
            } // Card
            } // PinnedSection rowContent
          } // item
          } // else visible
        }
        renameTarget?.let { rt ->
          RenameDialog(
            sessionId = rt.id,
            current = rt.title,
            onConfirm = { id, t -> vm.renameSession(id, t); renameTarget = null },
            onDismiss = { renameTarget = null }
          )
        }
        // Delete confirmation (same pattern as jobs delete).
        pendingSessionDelete?.let { target ->
          AlertDialog(
            onDismissRequest = { pendingSessionDelete = null },
            containerColor = Color(0xFF0C1017),
            title = {
              Text("Delete session?", color = TextPrimary, fontSize = 15.sp,
                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            },
            text = {
              Text("Delete \"${target.title.ifBlank { "untitled" }}\"? This cannot be undone.",
                color = TextSecondary, fontSize = 13.sp)
            },
            confirmButton = {
              TextButton(onClick = { vm.deleteSession(target.id); pendingSessionDelete = null }) {
                Text("Delete", color = NeonRed, fontFamily = FontFamily.Monospace,
                  fontWeight = FontWeight.Bold)
              }
            },
            dismissButton = {
              TextButton(onClick = { pendingSessionDelete = null }) {
                Text("Cancel", color = TextSecondary)
              }
            }
          )
        }
      }
    }
  ) {
    Scaffold(
      topBar = {
        Column(Modifier.fillMaxWidth().background(CyberBg)
          .statusBarsPadding()
          .padding(horizontal = 12.dp, vertical = 4.dp)) {
          // Control state language, hoisted: header pill + ribbon share it.
          val connLabel = when {
            connected -> "CONNECTED"
            install == InstallState.FAILED -> "ERROR"
            install == InstallState.RUNNING -> "CONNECTING"
            else -> "DISCONNECTED"
          }
          val connColor = when (connLabel) {
            "CONNECTED" -> NeonGreen
            "CONNECTING" -> NeonAmber
            "ERROR" -> NeonRed
            else -> TextSecondary
          }
          Row(Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { scope.launch { drawer.open() } },
              modifier = Modifier.size(36.dp)) {
              Icon(Icons.Filled.Menu, "sessions", tint = NeonCyan,
                modifier = Modifier.size(24.dp))
            }
            Spacer(Modifier.width(6.dp))
            // Logo box (same mark as Hermes Control).
            Box(Modifier.size(32.dp)
              .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .background(Color(0xFF16192E))
              .border(1.dp, NeonViolet.copy(alpha = 0.6f),
                androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .padding(4.dp),
              contentAlignment = Alignment.Center) {
              Image(painterResource(R.drawable.ic_hermes_logo), "Hermes",
                modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f, fill = false)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text("HERMES", color = TextPrimary, fontSize = 16.sp,
                  fontWeight = FontWeight.ExtraBold,
                  fontFamily = FontFamily.Monospace,
                  maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(" // MOBILE", color = NeonViolet, fontSize = 14.sp,
                  fontWeight = FontWeight.Bold,
                  fontFamily = FontFamily.Monospace, maxLines = 1)
              }
              Text("on-phone gateway · localhost:8080",
                color = TextSecondary, fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(6.dp))
            // Token pill (Control-style): Bolt glyph + session in/out usage,
            // always visible even at zero so layout never shifts.
            Box(Modifier.background(NeonAmber.copy(alpha = 0.10f),
              androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
              .border(1.dp, NeonAmber.copy(alpha = 0.35f),
                androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
              .padding(horizontal = 8.dp, vertical = 4.dp)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Bolt, "tokens", tint = NeonAmber,
                  modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(2.dp))
                Text("↑${fmtTok(usageIn)} · ↓${fmtTok(usageOut)}",
                  color = NeonCyan, fontSize = 9.sp,
                  fontFamily = FontFamily.Monospace,
                  fontWeight = FontWeight.SemiBold, maxLines = 1)
              }
            }
            Spacer(Modifier.width(6.dp))
            Box(Modifier.background(
              if (connLabel == "CONNECTED") NeonGreen
              else if (connLabel == "DISCONNECTED") CyberSurfaceElevated
              else connColor.copy(alpha = 0.15f),
              androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
              .padding(horizontal = 10.dp, vertical = 4.dp)) {
              Text(connLabel,
                color = if (connLabel == "CONNECTED") Color.Black
                  else if (connLabel == "DISCONNECTED") TextSecondary
                  else connColor,
                fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold)
            }
            // Approval badge (Control pattern): pending tool approvals surface
            // in the header so they are visible from any tab.
            if (approvalsTop.isNotEmpty()) {
              Spacer(Modifier.width(6.dp))
              Box(Modifier.background(NeonRed.copy(alpha = 0.15f),
                androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                .border(1.dp, NeonRed.copy(alpha = 0.5f),
                  androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                .padding(horizontal = 8.dp, vertical = 4.dp)) {
                Text("${approvalsTop.size} APPROVAL",
                  color = NeonRed, fontSize = 10.sp,
                  fontFamily = FontFamily.Monospace,
                  fontWeight = FontWeight.Bold, maxLines = 1)
              }
            }
          }
          // Action-needed banner only: hidden when gateway CONNECTED (saves vertical space).
          if (connLabel != "CONNECTED") {
            Spacer(Modifier.height(4.dp))
            // Status ribbon (Control-style card), single-line compact.
            Row(Modifier.fillMaxWidth()
              .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .background(Color(0xFF0F141C))
              .border(1.dp, CyberSurfaceBorder,
                androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .padding(horizontal = 10.dp, vertical = 4.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically) {
              Text("gateway $connLabel",
                color = connColor,
                fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
              Text(if (tab == 3) "STEP: SETTINGS > START" else if (connLabel == "CONNECTING") "STARTING..." else "OFFLINE · SEE SETTINGS",
                color = NeonCyan, fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
          }
          // Circuit-breaker banner: service gatewayFailed is otherwise
          // invisible + unrecoverable from here. Reason + explicit Retry.
          val gwFailed by vm.gatewayFailed.collectAsState()
          val gwReasonState by vm.gatewayFailureReason.collectAsState()
          if (gwFailed) {
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth()
              .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .background(Color(0xFF1C0F14))
              .border(1.dp, NeonRed.copy(alpha = 0.5f),
                androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
              .padding(horizontal = 10.dp, vertical = 6.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically) {
              Column(Modifier.weight(1f)) {
                Text("GATEWAY FAILED",
                  color = NeonRed, fontSize = 10.sp,
                  fontFamily = FontFamily.Monospace,
                  fontWeight = FontWeight.Bold,
                  maxLines = 1, overflow = TextOverflow.Ellipsis)
                val gwReason: String? = gwReasonState
                if (!gwReason.isNullOrBlank()) Text(gwReason,
                  color = TextSecondary, fontSize = 10.sp,
                  fontFamily = FontFamily.Monospace,
                  maxLines = 2, overflow = TextOverflow.Ellipsis)
              }
              Spacer(Modifier.width(8.dp))
              Button(onClick = { vm.start() },
                colors = ButtonDefaults.buttonColors(
                  containerColor = NeonViolet, contentColor = Color.White)) {
                Text("Retry", fontSize = 12.sp)
              }
            }
          }
        }
      },
      bottomBar = {
        NavigationBar(containerColor = CyberSurface,
          modifier = Modifier.navigationBarsPadding()) {
          // Phase 1 identity nav: Home, Chat, Activity (Jobs content),
          // Settings. Activity carries the pending-approvals badge.
          val navItems = listOf(
            Triple("HOME", Icons.Filled.Home, 0),
            Triple("CHAT", Icons.Filled.Chat, 0),
            Triple("ACTIVITY", Icons.Filled.List, approvalsTop.size),
            Triple("SETTINGS", Icons.Filled.Settings, 0)
          )
          navItems.forEachIndexed { i, (label, icon, badgeCount) ->
            NavigationBarItem(
              tab == i, { tab = i }, label = {
                Text(label, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
              }, icon = {
                BadgedBox(badge = {
                  if (badgeCount > 0) Badge(containerColor = NeonRed) {
                    Text("$badgeCount", fontSize = 10.sp,
                      fontFamily = FontFamily.Monospace)
                  }
                }) {
                  Icon(icon, label)
                }
              },
              colors = NavigationBarItemDefaults.colors(
                selectedIconColor = NeonVioletLight,
                unselectedIconColor = TextSecondary,
                selectedTextColor = NeonVioletLight,
                unselectedTextColor = TextSecondary,
                indicatorColor = Color(0xFF2E1065))
            )
          }
        }
      },
      containerColor = CyberBg
    ) { pad ->
      Box(Modifier.padding(pad)) {
        when (tab) {
          0 -> HomeTab(
            vm,
            onGoChat = { tab = 1 },
            // Composer autofocus needs a ChatTab edit (outside Home-owned
            // regions): for now this lands on Chat with the composer visible.
            onRunCommand = { tab = 1 },
            onGoActivity = { tab = 2 },
            onGoSettings = { tab = 3 }
          )
          1 -> ChatTab(vm, onGoSettings = { tab = 3 })
          // Activity tab keeps the existing Jobs screen as-is (entry renamed).
          2 -> JobsTab(vm)
          else -> SettingsRoot(vm)
        }
      }
    }
  }
}

@Composable
fun ChatTab(vm: MobileViewModel, onGoSettings: () -> Unit = {}) {
  val chat by vm.chat.collectAsState()
  val streaming by vm.streaming.collectAsState()
  val models by vm.models.collectAsState()
  val approvals by vm.approvals.collectAsState()
  val sid by vm.currentSessionId.collectAsState()
  val connected by vm.connected.collectAsState()
  var text by remember { mutableStateOf("") }
  var renameOpen by remember { mutableStateOf(false) }
  // Async send failure (e.g. session creation failed after the draft was
  // cleared): the FailedDraft is restored below, after attachedImages exists.
  val failedDraft by vm.failedDraft.collectAsState()
  val listState = rememberLazyListState()
  val scopeJump = rememberCoroutineScope()
  val clip = LocalClipboardManager.current
  val ctx = LocalContext.current
  val turnMeta by vm.turnMeta.collectAsState()
  val appLog by vm.log.collectAsState()
  var dismissedError by remember { mutableStateOf<String?>(null) }
  val queued by vm.queuedMessages.collectAsState()
  var searchOpen by remember { mutableStateOf(false) }
  var searchQuery by remember { mutableStateOf("") }
  var showModels by remember { mutableStateOf(false) }
  // Viewport-follow (Control ChatTerminalScreen pattern): stick to the bottom
  // only while the user is at the bottom; never yank them from history.
  var userFollows by remember { mutableStateOf(true) }
  var isProgrammaticScroll by remember { mutableStateOf(false) }
  var lastScrolledSession by remember { mutableStateOf<String?>(null) }
  var prevChatSize by remember { mutableStateOf(0) }
  // Image attach: GetContent → base64 data URL (Control vision-parts pattern).
  // No /api/files route exists on the gateway, so generic file-attach stays
  // disabled; images ride inline as message parts, no upload needed.
  var attachedImages by remember { mutableStateOf(listOf<String>()) }
  val imgResolver = LocalContext.current.contentResolver
  val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
    if (uri == null) return@rememberLauncherForActivityResult
    try {
      val bytes: ByteArray? = imgResolver.openInputStream(uri)?.use { it.readBytes() }
      if (bytes == null || bytes.isEmpty()) { vm.addLogPublic("image read failed"); return@rememberLauncherForActivityResult }
      if (bytes.size > 5 * 1024 * 1024) { vm.addLogPublic("image too large (5MB max)"); return@rememberLauncherForActivityResult }
      val mime = imgResolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: "image/jpeg"
      attachedImages = (attachedImages + "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)).take(4)
    } catch (e: Exception) { vm.addLogPublic("image attach failed: ${e.message}") }
  }
  // Failed send restore: text back into the input plus any attached images
  // the VM preserved (session-create failure path). Runs here because
  // attachedImages is in scope.
  LaunchedEffect(failedDraft) {
    failedDraft?.let { draft ->
      text = draft.text
      // Re-save: the send path cleared the DraftStore entry on accept, so
      // the restored text must be persisted again or the next switch loses it.
      DraftStore.save(ctx, sid, draft.text)
      if (draft.imageDataUrls.isNotEmpty()) {
        attachedImages = (attachedImages + draft.imageDataUrls).take(4)
      }
      vm.consumeFailedDraft()
    }
  }
  // Streaming elapsed timer for StreamStatusLine.
  var streamStartMs by remember { mutableStateOf(0L) }
  var streamElapsed by remember { mutableStateOf(0L) }
  LaunchedEffect(streaming) {
    if (streaming) {
      streamStartMs = System.currentTimeMillis()
      streamElapsed = 0L
      while (true) {
        kotlinx.coroutines.delay(1000)
        streamElapsed = (System.currentTimeMillis() - streamStartMs) / 1000
      }
    }
  }

  // Filtered view for in-chat search; blank query returns the full list.
  val visibleChat = if (searchOpen) filterMessages(chat, searchQuery) else chat
  // Track whether the user sits at the true bottom (Control isAtTrueBottom).
  LaunchedEffect(listState, visibleChat.size) {
    snapshotFlow {
      val atBottom = isChatAtTrueBottom(listState, visibleChat.size)
      val inProgress = listState.isScrollInProgress
      Pair(atBottom, inProgress)
    }.collect { (atBottom, inProgress) ->
      if (inProgress && !isProgrammaticScroll) {
        userFollows = atBottom
      } else if (!inProgress && atBottom) {
        userFollows = true
      }
    }
  }
  // Follow the live tail: new sessions/messages and streaming deltas scroll
  // only when the user follows; user scroll-up pauses, jump resumes.
  val lastChat = visibleChat.lastOrNull()
  val lastContentLen = lastChat?.content?.length ?: 0
  val lastThinkingLen = lastChat?.thinking?.length ?: 0
  val lastToolsCount = lastChat?.tools?.size ?: 0
  LaunchedEffect(sid, visibleChat.size, lastContentLen, lastThinkingLen, lastToolsCount, streaming) {
    if (visibleChat.isEmpty()) return@LaunchedEffect
    val isNewSession = sid != null && lastScrolledSession != sid
    val isNewMessage = visibleChat.size > prevChatSize
    prevChatSize = visibleChat.size
    if (isNewMessage) userFollows = true
    if (isNewSession || userFollows) {
      isProgrammaticScroll = true
      try {
        listState.scrollToItem(visibleChat.size - 1, scrollOffset = 500_000)
      } finally {
        isProgrammaticScroll = false
      }
      lastScrolledSession = sid
    }
  }

  Column(Modifier.fillMaxSize().padding(12.dp).imePadding()) {
    // Agent Workspace header: agent name + status badge, never raw text.
    val curModelId = vm.modelId().ifBlank { models.firstOrNull()?.id.orEmpty() }
    val curModelName = models.firstOrNull { it.id == curModelId }?.displayName
      ?: curModelId.ifBlank { "" }
    AgentHeader(
      connected = connected,
      streaming = streaming,
      hasSession = sid != null || chat.isNotEmpty(),
      modelName = curModelName,
      elapsedSecs = streamElapsed,
      onOpenModels = { showModels = true }
    )
    Spacer(Modifier.height(6.dp))
    // Chat search shares a slim row (right-aligned); the model picker now
    // lives inside the composer card (Control pattern).
    if (chat.size > 15 && !searchOpen) {
      Row(Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End) {
        ChatSearchButton(visible = true) { searchOpen = true }
      }
      Spacer(Modifier.height(6.dp))
    }
    if (showModels) {
      // AiModelInfo carries no provider; best-effort: id prefix before "/",
      // else the saved provider for every row.
      val v2models = models.map { m ->
        AiModelInfoV2(
          id = m.id,
          displayName = m.displayName,
          provider = m.id.substringBefore("/").takeIf { "/" in m.id } ?: vm.provider()
        )
      }
      ModelsSheet(
        models = v2models,
        selectedId = curModelId,
        onSelect = { picked ->
          vm.saveKeys(vm.provider(), vm.apiKey(), picked.id, vm.baseUrl(), vm.tgToken(),
            vm.discordToken(), vm.serverKey(), vm.autostart())
          showModels = false
        },
        onDismiss = { showModels = false }
      )
    }
    if (searchOpen) {
      ChatSearchBar(
        query = searchQuery,
        onQuery = { searchQuery = it },
        onClose = { searchOpen = false }
      )
      Spacer(Modifier.height(6.dp))
    }
    // Approvals render above the input as prominent cards, so they never
    // push the chat tail off screen.
    val showJump by remember {
      derivedStateOf { listState.canScrollForward }
    }
    Box(Modifier.weight(1f)) {
      if (visibleChat.isEmpty()) {
        if (searchOpen && searchQuery.isNotBlank()) {
          // Zero-match filter: explicit no-results state, never a blank list.
          Column(Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center) {
            Text("No messages match \"$searchQuery\"",
              color = TextSecondary, fontSize = 13.sp,
              fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { searchQuery = "" }) {
              Text("CLEAR SEARCH", color = NeonCyan, fontSize = 12.sp,
                fontFamily = FontFamily.Monospace)
            }
          }
        } else {
        // Agent Workspace empty state: honest copy + suggestion chips.
        WorkspaceEmptyState(
          connected = connected,
          onGoSettings = { vm.coldStart(); onGoSettings() },
          onSuggest = { s -> text = s; DraftStore.save(ctx, sid, s) },
          modifier = Modifier.fillMaxSize()
        )
        }
      }
      LazyColumn(state = listState, modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(bottom = 96.dp)) {
        items(visibleChat, key = { it.id }) { m ->
          val meta = turnMeta[m.id]
          // Only the live tail bubble gets the streaming treatment (cursor +
          // expanded tool lines); history rows always render collapsed.
          val isLiveTail = streaming && m.id == visibleChat.lastOrNull()?.id
          MessageRow(
            m,
            modelName = meta?.model.orEmpty(),
            durationMs = meta?.durationMs ?: 0L,
            isStreaming = isLiveTail,
            onRegenerate = { vm.send(it) },
            onBranch = { sid?.let { id -> vm.forkSession(id) } },
            onCopy = { clip.setText(AnnotatedString(it)) }
          )
        }
      }
      JumpToBottom(
        visible = showJump,
        onClick = {
          userFollows = true
          scopeJump.launch {
            isProgrammaticScroll = true
            try {
              listState.scrollToItem(visibleChat.size - 1, scrollOffset = 500_000)
            } finally {
              isProgrammaticScroll = false
            }
          }
        },
        modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp)
      )
    }
    // ── Composer power: per-session draft + slash catalog + mentions ──
    val context = LocalContext.current
    // Restore the saved draft whenever the session changes. DraftStore
    // persists text only, so attached images are stashed per session in the
    // VM (stashImageDraft/imageDraft) or a switch would silently drop them.
    var lastDraftSid by remember { mutableStateOf<String?>(null) }
    var draftInit by remember { mutableStateOf(false) }
    LaunchedEffect(sid) {
      if (draftInit) {
        vm.stashImageDraft(lastDraftSid, attachedImages)
      }
      if (draftInit && lastDraftSid == null && text.isNotBlank()) {
        // First-turn race: a follow-up typed while the new session was being
        // created was saved under draft_none; carry it to the new session
        // instead of overwriting it with the (empty) new-session draft.
        DraftStore.save(context, sid, text)
      } else {
        text = DraftStore.load(context, sid)
        attachedImages = vm.imageDraft(sid)
      }
      lastDraftSid = sid
      draftInit = true
      searchOpen = false
      searchQuery = ""
    }
    // Single write path: every edit persists the per-session draft.
    fun updateDraft(v: String) {
      text = v
      DraftStore.save(context, sid, v)
    }
    val lastUserText = chat.lastOrNull { it.sender == "you" }?.content.orEmpty()
    fun handleSlash(cmd: SlashCommand) {
      when (cmd.trigger) {
        "/new" -> { vm.newSession(); updateDraft("") }
        "/retry" -> if (lastUserText.isNotBlank()) {
          vm.send(lastUserText)
          updateDraft("")
        }
        else -> {
          // Replace only the /token being typed, keep the rest of the draft.
          val tokenStart = (maxOf(text.lastIndexOf(' '), text.lastIndexOf('\n')) + 1)
            .coerceIn(0, text.length)
          updateDraft(text.substring(0, tokenStart) + cmd.trigger + " ")
        }
      }
    }
    // Single send path: text + attached images; clears both on accept.
    fun doSend(): Boolean {
      if (!vm.send(text, attachedImages)) return false
      updateDraft("")
      attachedImages = emptyList()
      return true
    }
    // ONE merged command row: slash pills + @mentions, end-padded so the
    // last chip never clips. Active /token typing gets the filtered
    // SlashCatalog popover instead.
    val slashToken = text.substringAfterLast(' ').substringAfterLast('\n')
    val showSlashPopover = !streaming && text.isNotBlank() && slashToken.startsWith("/")
    if (showSlashPopover) {
      SlashCatalog(
        text = text,
        onPick = { updateDraft(if (text.isBlank()) it else text + it) },
        onCommand = ::handleSlash
      )
      Spacer(Modifier.height(6.dp))
    } else if (!streaming && text.isBlank()) {
      CommandPillsRow(
        onSlash = ::handleSlash,
        onMention = { token ->
          updateDraft(
            if (text.isEmpty() || text.endsWith(" ") || text.endsWith("\n")) text + token + " "
            else "$text $token "
          )
        }
      )
      Spacer(Modifier.height(6.dp))
    }
    if (attachedImages.isNotEmpty()) {
      Row(verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${attachedImages.size} image(s) attached",
          color = NeonCyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        TextButton(onClick = { attachedImages = emptyList() }) {
          Text("Clear", color = TextSecondary, fontSize = 11.sp)
        }
      }
      Spacer(Modifier.height(4.dp))
    }
    // Streaming row (Control pattern): Queue + Send-now + Stop while live.
    StreamingControls(
      isStreaming = streaming,
      hasText = text.isNotBlank() || attachedImages.isNotEmpty(),
      onQueue = {
        if (vm.queueMessage(text, attachedImages)) {
          updateDraft("")
          attachedImages = emptyList()
        }
      },
      onSendNow = {
        if (vm.sendNow(text, attachedImages)) {
          updateDraft("")
          attachedImages = emptyList()
        }
      },
      onStop = { vm.stopStream() }
    )
    QueuedBanner(count = queued.size, onCancel = { vm.cancelQueued() })
    if (queued.isNotEmpty()) Spacer(Modifier.height(4.dp))
    // PROMINENT approval card above the input: big DENY/APPROVE, never an
    // inline line. Same resolveApproval callbacks; first pending wins.
    val activeApproval = approvals.firstOrNull()
    // Failed-turn banner with retry, above the composer.
    val lastError = appLog.lastOrNull {
      it.contains("fail", ignoreCase = true) || it.contains("error", ignoreCase = true)
    }
    if (lastError != null && lastError != dismissedError && !streaming) {
      TurnErrorBanner(
        message = lastError,
        onRetry = {
          dismissedError = lastError
          if (lastUserText.isNotBlank()) vm.send(lastUserText)
        },
        onDismiss = { dismissedError = lastError }
      )
      Spacer(Modifier.height(6.dp))
    }
    if (activeApproval != null) {
      ProminentApprovalCard(
        summary = activeApproval.summary,
        onAllow = { mode -> vm.resolveApproval(activeApproval, true, mode) },
        onDeny = { vm.resolveApproval(activeApproval, false) }
      )
      Spacer(Modifier.height(6.dp))
    }
    // Composer card (Control pattern): one rounded card, text zone on top,
    // toolbar row inside below: [+] [model v] [effort v] ... [mic] [send].
    val effort = ReasoningEffort.selected.value
    val effortLabel = when (effort.lowercase()) {
      "low" -> "LOW"
      "high" -> "HIGH"
      "none" -> "OFF"
      else -> "MED"
    }
    // Agent Workspace composer: new surface, same function (model picker,
    // effort, mic, send, queue/stop all intact).
    Card(
      colors = CardDefaults.cardColors(
        containerColor = CyberSurfaceElevated.copy(alpha = 0.96f)),
      border = androidx.compose.foundation.BorderStroke(
        1.dp, NeonViolet.copy(alpha = 0.35f)),
      shape = androidx.compose.foundation.shape.RoundedCornerShape(22.dp),
      modifier = Modifier.fillMaxWidth()
    ) {
      Column(Modifier.padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
          text, { updateDraft(it) }, Modifier.fillMaxWidth(),
          placeholder = { Text("Message...") },
          colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
            focusedBorderColor = Color.Transparent,
            unfocusedBorderColor = Color.Transparent,
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent),
          maxLines = 4,
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
          keyboardActions = KeyboardActions(
            onSend = { doSend() }
          )
        )
        // Toolbar scrolls horizontally on narrow screens (360dp safe).
        Row(
          modifier = Modifier.fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          IconButton(onClick = { imagePicker.launch("image/*") }) {
            Icon(Icons.Filled.Add, "attach image", tint = TextSecondary)
          }
          TextButton(onClick = { showModels = true }) {
            Text(
              (if (models.isNotEmpty()) curModelName.ifBlank { "model" }.take(16) else "No model") + " ▾",
              fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
              color = TextPrimary, fontFamily = FontFamily.Monospace)
          }
          TextButton(onClick = {
            val next = when (ReasoningEffort.selected.value.lowercase()) {
              "none" -> "low"
              "low" -> "medium"
              "medium" -> "high"
              else -> "none"
            }
            ReasoningEffort.save(ctx, next)
          }) {
            Text(effortLabel + " ▾", fontSize = 11.sp,
              color = NeonVioletLight, fontFamily = FontFamily.Monospace)
          }
          Spacer(Modifier.width(8.dp))
          VoiceInputButton(onResult = { updateDraft(it) })
          if (!streaming) {
            if (lastUserText.isNotBlank()) {
              IconButton(onClick = { vm.send(lastUserText) }) {
                Icon(Icons.Filled.Refresh, "retry last", tint = TextSecondary)
              }
            }
            IconButton(onClick = { doSend() }) {
              Icon(Icons.Filled.Send, "send", tint = NeonViolet)
            }
          }
        }
      }
    }
    if (sid != null) {
      Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { vm.newSession() }) {
          Text("New", color = NeonVioletLight, fontSize = 12.sp)
        }
        TextButton(onClick = { renameOpen = true }) {
          Text("Rename", color = TextSecondary, fontSize = 12.sp)
        }
      }
    }
    if (renameOpen && sid != null) {
      var name by remember { mutableStateOf("") }
      AlertDialog(
        onDismissRequest = { renameOpen = false },
        containerColor = Color(0xFF0C1017),
        title = {
          Text("Rename session", color = TextPrimary, fontSize = 15.sp,
            fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        },
        text = { OutlinedTextField(name, { name = it }, singleLine = true) },
        confirmButton = {
          TextButton(onClick = {
            vm.renameSession(sid!!, name); renameOpen = false
          }) {
            Text("Save", color = NeonViolet, fontFamily = FontFamily.Monospace,
              fontWeight = FontWeight.Bold)
          }
        },
        dismissButton = {
          TextButton(onClick = { renameOpen = false }) {
            Text("Cancel", color = TextSecondary)
          }
        }
      )
    }
  }
}

// True-bottom check (Control isAtTrueBottom): last item visible AND its
// bottom edge inside the viewport (40px slop), or nothing to scroll.
private fun isChatAtTrueBottom(listState: LazyListState, totalItems: Int): Boolean {
  if (totalItems <= 0) return true
  val layoutInfo = listState.layoutInfo
  val visibleItems = layoutInfo.visibleItemsInfo
  if (visibleItems.isEmpty()) return true
  val lastVisible = visibleItems.last()
  if (lastVisible.index < totalItems - 1) return false
  val bottomEdge = lastVisible.offset + lastVisible.size
  val viewportBottom = layoutInfo.viewportEndOffset
  return !listState.canScrollForward || bottomEdge <= viewportBottom + 40
}

@Composable
fun MessageRow(
  m: ChatMessage,
  modelName: String = "",
  durationMs: Long = 0L,
  isStreaming: Boolean = false,
  onRegenerate: (String) -> Unit = {},
  onBranch: () -> Unit = {},
  onCopy: (String) -> Unit = {}
) {
  val you = m.sender == "you"
  val ctx = LocalContext.current
  // Agent Workspace surfaces: user violet tint, agent deep-navy + cyan edge.
  val bubbleBg = (if (you) Color(0xFF23143F) else CyberSurfaceElevated).copy(alpha = 0.95f)
  val bubbleEdge = if (you) NeonViolet else NeonCyan
  val bubbleShape = if (you)
    androidx.compose.foundation.shape.RoundedCornerShape(
      topStart = 14.dp, topEnd = 4.dp, bottomStart = 14.dp, bottomEnd = 14.dp)
  else
    androidx.compose.foundation.shape.RoundedCornerShape(
      topStart = 4.dp, topEnd = 14.dp, bottomStart = 14.dp, bottomEnd = 14.dp)
  // Bubbles stay LTR even in RTL locales (Control pattern).
  CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
    Row(Modifier.fillMaxWidth(),
      horizontalArrangement = if (you) Arrangement.End else Arrangement.Start) {
      Column(
        Modifier.fillMaxWidth(if (you) 0.85f else 0.95f)
          .background(bubbleBg, bubbleShape)
          .border(1.dp, bubbleEdge.copy(alpha = 0.5f), bubbleShape)
          .padding(horizontal = 14.dp, vertical = 10.dp)
      ) {
        // Workspace group label: USER / HERMES, never a bare bubble.
        SenderLabel(isUser = you)
        // Header: model (agent) + duration + copy with toast.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          val headerLabel = when {
            you -> "you"
            modelName.isNotBlank() && durationMs > 0 -> "$modelName · ${durationMs}ms"
            modelName.isNotBlank() -> modelName
            durationMs > 0 -> "HERMES · ${durationMs}ms"
            else -> "HERMES"
          }
          Text(headerLabel,
            color = TextSecondary, fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f))
          IconButton(
            onClick = {
              onCopy(m.content.ifBlank { m.thinking })
              Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
            },
            modifier = Modifier.size(24.dp)
          ) {
            Icon(Icons.Filled.ContentCopy, "copy message",
              tint = TextSecondary, modifier = Modifier.size(14.dp))
          }
        }
        Spacer(Modifier.height(2.dp))
        ThinkingBlock(
          thinking = m.thinking,
          done = m.thinkingDone,
          fontScale = ChatFontScale.value
        )
        // Legacy tool-name strings render as completed executions; the VM
        // appends names only, so running state is unavailable here.
        // Block logic untouched, WorkspaceToolCard only re-skins the container.
        WorkspaceToolCard(
          tools = m.tools.distinct().map { name ->
            ToolExecution(id = name, toolName = name, status = "completed")
          },
          isStreaming = isStreaming
        )
        if (m.content.isNotBlank()) {
          SelectionContainer {
            // Static block cursor while the tail streams (no blink driver).
            renderRichText(m.content + if (isStreaming && !you) " ▍" else "",
              ChatFontScale.value)
          }
          if (you) {
            Spacer(Modifier.height(2.dp))
            MessageActionsRow(
              onRegenerate = { onRegenerate(m.content) },
              onBranch = onBranch,
              onCopy = {
                onCopy(m.content)
                Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
              }
            )
          }
          if (!you) {
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
              TtsSpeaker(m.content)
            }
            MessageFooter(modelName = modelName, durationMs = durationMs)
          }
        } else if (m.thinkingDone) {
          Text("...", color = TextSecondary, fontSize = 14.sp)
        }
      }
    }
  }
}

@Composable
fun JobsTab(vm: MobileViewModel) {
  val jobs by vm.jobs.collectAsState()
  var name by remember { mutableStateOf("") }
  var sched by remember { mutableStateOf("") }
  var prompt by remember { mutableStateOf("") }
  var query by remember { mutableStateOf("") }
  var pendingDelete by remember { mutableStateOf<ee.oversight.hermes.mobile.model.CronJob?>(null) }
  val runs by vm.runs.collectAsState()
  var historyFor by remember { mutableStateOf<String?>(null) }
  // Create-form guards: validation message + busy flag against double-tap
  // duplicates (vm.createJob is fire-and-forget, so the UI owns the guard).
  var createError by remember { mutableStateOf("") }
  var createBusy by remember { mutableStateOf(false) }
  val createScope = rememberCoroutineScope()

  LaunchedEffect(Unit) { vm.refreshJobs() }
  // Re-arm the Create button once the list refreshes after a successful create.
  LaunchedEffect(jobs) { createBusy = false }
  val q = query.trim().lowercase()
  val visible = if (q.isEmpty()) jobs else jobs.filter {
    it.name.lowercase().contains(q) || it.prompt.lowercase().contains(q)
  }
  LazyColumn(Modifier.fillMaxSize().padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
    contentPadding = PaddingValues(bottom = 96.dp)) {
    item {
      Text("// SCHEDULED JOBS", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      Spacer(Modifier.height(8.dp))
      Card(colors = CardDefaults.cardColors(containerColor = CyberSurface),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
          Text("New job", color = TextPrimary, fontSize = 14.sp,
            fontWeight = FontWeight.Bold)
          Spacer(Modifier.height(8.dp))
          WizardField(name, { name = it }, "name")
          WizardField(sched, { sched = it }, "schedule")
          // Schedule presets fill the schedule field.
          Row(horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            val presets = listOf(
              "Once" to "once",
              "Daily" to "every day 9am",
              "Weekdays" to "every weekday 9am",
              "Hourly" to "every 1h"
            )
            presets.forEach { (label, value) ->
              OutlinedButton(onClick = { sched = value }) { Text(label, fontSize = 12.sp) }
            }
          }
          Text(
            "…or type any schedule, e.g. cron `0 9 * * *`",
            color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace
          )
          Spacer(Modifier.height(8.dp))
          WizardField(prompt, { prompt = it }, "prompt")
          if (createError.isNotBlank()) {
            Text(createError, color = NeonRed, fontSize = 12.sp)
            Spacer(Modifier.height(4.dp))
          }
          Button(
            onClick = {
              if (createBusy) return@Button
              val missing = listOf(
                "name" to name.isBlank(),
                "schedule" to sched.isBlank(),
                "prompt" to prompt.isBlank()
              ).filter { it.second }.map { it.first }
              if (missing.isNotEmpty()) {
                createError = "required: ${missing.joinToString(", ")}"
                return@Button
              }
              createError = ""
              createBusy = true
              vm.createJob(name.trim(), sched.trim(), prompt.trim())
              name = ""; sched = ""; prompt = ""
              // Safety re-arm if the list never refreshes (e.g. create failed).
              createScope.launch {
                kotlinx.coroutines.delay(5000)
                createBusy = false
              }
            },
            enabled = !createBusy,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = NeonViolet,
              contentColor = Color.White)
          ) { Text(if (createBusy) "Creating..." else "Create job") }
        }
      }
      Spacer(Modifier.height(8.dp))
      if (jobs.isNotEmpty()) {
        OutlinedTextField(
          value = query, onValueChange = { query = it },
          label = { Text("Search name or prompt") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(4.dp))
      }
    }
    items(visible, key = { it.id }) { j ->
      val failed = j.lastStatus.lowercase() in listOf("failed", "error") ||
        (j.lastStatus.isBlank() && j.lastError.isNotBlank())
      val overdue = isOverdue(j.nextRunAt, j.enabled, j.state)
      Card(colors = CardDefaults.cardColors(containerColor = CyberSurface),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(j.name, color = TextPrimary, fontSize = 14.sp,
              modifier = Modifier.weight(1f))
            if (overdue) Text("OVERDUE", color = NeonRed, fontSize = 11.sp,
              fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
          }
          Text("${j.scheduleDisplay} · ${j.state}", color = TextSecondary,
            fontSize = 12.sp, fontFamily = FontFamily.Monospace)
          if (j.nextRunAt.isNotBlank()) Text("next ${j.nextRunAt}",
            color = if (overdue) NeonRed else TextSecondary, fontSize = 11.sp)
          if (failed) {
            val firstLine = j.lastError.lineSequence().firstOrNull { it.isNotBlank() }
              ?.trim()?.take(200) ?: "last run failed"
            Text(firstLine, color = NeonRed, fontSize = 12.sp,
              maxLines = 1, overflow = TextOverflow.Ellipsis)
          }
          Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (j.enabled) TextButton(onClick = { vm.jobAction(j.id, "pause") }) {
              Text("Pause", color = TextSecondary)
            }
            else TextButton(onClick = { vm.jobAction(j.id, "resume") }) {
              Text("Resume", color = NeonCyan)
            }
            TextButton(onClick = { vm.jobAction(j.id, "run") }) {
              Text("Run now", color = NeonCyan)
            }
            TextButton(onClick = {
              historyFor = if (historyFor == j.id) null else j.id
              vm.refreshRuns(j.id)
            }) {
              Text(if (historyFor == j.id) "Hide history" else "History", color = TextSecondary)
            }
            IconButton(onClick = { pendingDelete = j }) {
              Icon(Icons.Filled.Delete, "delete", tint = NeonRed)
            }
          }
          if (historyFor == j.id) {
            val jobRuns = runs[j.id].orEmpty()
            Spacer(Modifier.height(4.dp))
            Text("// run history", color = NeonCyan, fontSize = 11.sp,
              fontFamily = FontFamily.Monospace)
            if (jobRuns.isEmpty()) {
              Text("No runs recorded for this job yet.", color = TextSecondary, fontSize = 12.sp)
            } else {
              jobRuns.take(10).forEach { r ->
                val errLine = r.error.lineSequence().firstOrNull { it.isNotBlank() }
                  ?.trim()?.take(160)
                Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                  Text(
                    "• ${r.status.ifBlank { "?" }}${if (r.startedAt.isNotBlank()) " · ${r.startedAt}" else ""}",
                    color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace
                  )
                  if (!errLine.isNullOrBlank()) {
                    Text(errLine, color = NeonRed, fontSize = 11.sp,
                      maxLines = 1, overflow = TextOverflow.Ellipsis)
                  }
                }
              }
            }
          }
        }
      }
    }
    if (jobs.isEmpty() && q.isEmpty()) {
      item {
        Text(
          "No jobs yet. Create your first scheduled job above — pick a preset or type a schedule.",
          color = TextSecondary, fontSize = 13.sp
        )
      }
    } else if (visible.isEmpty()) {
      item {
        Text("No jobs match \"$query\".", color = TextSecondary, fontSize = 13.sp)
      }
    }
  }
  // Delete confirmation dialog.
  pendingDelete?.let { target ->
    AlertDialog(
      onDismissRequest = { pendingDelete = null },
      containerColor = Color(0xFF0C1017),
      title = {
        Text("Delete job?", color = TextPrimary, fontSize = 15.sp,
          fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
      },
      text = {
        Text("Delete \"${target.name}\"? This cannot be undone.",
          color = TextSecondary, fontSize = 13.sp)
      },
      confirmButton = {
        TextButton(onClick = { vm.jobAction(target.id, "delete"); pendingDelete = null }) {
          Text("Delete", color = NeonRed, fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold)
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingDelete = null }) {
          Text("Cancel", color = TextSecondary)
        }
      }
    )
  }
}

/** True when an ISO-8601 next-run timestamp is already in the past.
 * Paused or disabled jobs never count as overdue. */
private fun isOverdue(nextRunAt: String, enabled: Boolean = true, state: String = ""): Boolean {
  if (!enabled) return false
  val st = state.trim().lowercase()
  if (st == "paused" || st == "disabled") return false
  if (nextRunAt.isBlank()) return false
  return try {
    val instant = java.time.Instant.parse(nextRunAt.trim())
    instant.isBefore(java.time.Instant.now())
  } catch (_: Exception) {
    // Also accept epoch millis / epoch seconds strings.
    try {
      val n = nextRunAt.trim().toLong()
      val millis = if (n < 10_000_000_000L) n * 1000 else n
      millis < System.currentTimeMillis()
    } catch (_: Exception) { false }
  }
}

@Composable
fun SystemTab(vm: MobileViewModel) {
  val status by vm.status.collectAsState()
  val connected by vm.connected.collectAsState()
  val appLog by vm.log.collectAsState()
  var gwTail by remember { mutableStateOf(listOf("press Refresh status to read gateway.log")) }

  // Order: status > actions > logs > advanced (logs + advanced live in OpsPanel).
  LazyColumn(Modifier.fillMaxSize().padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    contentPadding = PaddingValues(bottom = 96.dp)) {
    item {
      Text("// SYSTEM", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      Card(colors = CardDefaults.cardColors(containerColor = CyberSurface),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
          Text(if (connected) "GATEWAY LIVE" else "GATEWAY DOWN",
            color = if (connected) NeonGreen else NeonRed,
            fontFamily = FontFamily.Monospace, fontSize = 14.sp,
            fontWeight = FontWeight.Bold)
          if (status.version.isNotBlank()) Text("v${status.version}",
            color = TextSecondary, fontSize = 12.sp)
          if (status.gatewayState.isNotBlank()) Text("state ${status.gatewayState}",
            color = TextSecondary, fontSize = 12.sp)
          status.platforms.forEach { (k, v) ->
            Text("$k: $v", color = TextTerminal, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace)
          }
          if (status.detail.isNotBlank() && !connected) Text(status.detail,
            color = TextSecondary, fontSize = 12.sp)
        }
      }
    }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { gwTail = vm.serviceLogTail() },
          colors = ButtonDefaults.buttonColors(containerColor = NeonViolet,
            contentColor = Color.White)) {
          Text("Refresh status")
        }
        OutlinedButton(onClick = { vm.start() }) { Text("Start") }
        OutlinedButton(onClick = { vm.stop() }) { Text("Stop") }
      }
    }
    item {
      // Single log section: file tail + endpoint viewer merged under one
      // heading inside OpsPanel; app log capped at 5 lines + expand link.
      OpsPanel(
        baseUrl = "http://127.0.0.1:8080",
        apiKey = vm.serverKey(),
        fileTail = gwTail,
        appTail = appLog
      )
    }
  }
}

