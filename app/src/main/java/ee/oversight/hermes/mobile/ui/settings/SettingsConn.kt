package ee.oversight.hermes.mobile.ui.settings

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.BuildConfig
import ee.oversight.hermes.mobile.InstallState
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.network.GatewayClient
import ee.oversight.hermes.mobile.service.MobileGatewayService
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import kotlinx.coroutines.launch

// ── ConnSection: self-contained connection block (copied out of SetupTab) ──
// All helpers below are local copies — nothing is imported from MainActivity.

private val ConnProviderOptions = listOf(
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

private val ConnProviderAliases = mapOf(
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
  "kilo" to "kilocode", "kilo-code" to "kilocode", "kilocode-gateway" to "kilocode",
  "lm-studio" to "lmstudio", "lm_studio" to "lmstudio"
)

private val ConnKnownProviders: Set<String> = ConnProviderOptions.map { it.first }.toSet()

private fun connNormProvider(p: String): String {
  val slug = p.trim().lowercase().replace(Regex("\\s+"), "-")
  return ConnProviderAliases[slug] ?: slug
}

private fun connKeysValid(provider: String, key: String, baseUrl: String): Boolean {
  if (key.isBlank()) return false
  // Empty custom id must never validate, and must never fall back to
  // deepseek+baseUrl. A non-blank custom id requires a base URL.
  if (provider.isBlank()) return false
  val p = connNormProvider(provider)
  if (p.isBlank()) return false
  return p in ConnKnownProviders || baseUrl.isNotBlank()
}

/** Bumped on every ConnSection Save so GatewaySection re-reads prefs. */
object SettingsPrefsTick {
  var tick by mutableStateOf(0)
    private set
  fun bump() { tick++ }
}

@Composable
private fun ConnProviderPicker(value: String, onChange: (String) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  val normed = connNormProvider(value)
  var custom by remember(value) {
    mutableStateOf(value.isNotBlank() && normed !in ConnKnownProviders)
  }
  if (!custom) {
    val current = ConnProviderOptions.firstOrNull { it.first == normed }
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
      Box(Modifier.matchParentSize().clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null) { expanded = true })
      DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        ConnProviderOptions.forEach { (id, name) ->
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
    ConnField(value, onChange, "custom provider id")
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

@Composable
private fun ConnSecretField(value: String, onChange: (String) -> Unit, label: String) {
  var visible by remember { mutableStateOf(false) }
  OutlinedTextField(
    value, onChange, label = { Text(label) }, modifier = Modifier.fillMaxWidth(),
    singleLine = true,
    visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
    trailingIcon = {
      IconButton(onClick = { visible = !visible }) {
        Icon(
          if (visible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
          contentDescription = if (visible) "hide key" else "show key",
          tint = TextSecondary
        )
      }
    },
    colors = OutlinedTextFieldDefaults.colors(
      focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
      focusedBorderColor = NeonViolet, unfocusedBorderColor = CyberSurfaceElevated,
      focusedLabelColor = NeonVioletLight, unfocusedLabelColor = TextSecondary)
  )
  Spacer(Modifier.height(8.dp))
}

@Composable
private fun ConnField(value: String, onChange: (String) -> Unit, label: String) {
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

/** Connection block extracted from SetupTab: status header, provider/key/model/
 *  baseUrl fields, telegram/discord/local-key fields, tri-state
 *  Test-key button, Save/Install buttons. All state lives here + vm methods.
 *  Autostart is owned by GatewaySection (this section passes it through). */
@Composable
fun ConnSection(vm: MobileViewModel) {
  val install by vm.install.collectAsState()
  val installError by vm.installError.collectAsState()
  val connected by vm.connected.collectAsState()
  val progress by vm.progress.collectAsState()
  // Keyed on vm prefs so external edits (wizard / model sheet) refresh fields.
  val initProvider = vm.provider()
  val initKey = vm.apiKey()
  val initModel = vm.modelId()
  val initBaseUrl = vm.baseUrl()
  val initTg = vm.tgToken()
  val initDiscord = vm.discordToken()
  val initSkey = vm.serverKey()
  var provider by remember(initProvider) { mutableStateOf(initProvider) }
  var key by remember(initKey) { mutableStateOf(initKey) }
  var model by remember(initModel) { mutableStateOf(initModel) }
  var baseUrl by remember(initBaseUrl) { mutableStateOf(initBaseUrl) }
  var tg by remember(initTg) { mutableStateOf(initTg) }
  var discord by remember(initDiscord) { mutableStateOf(initDiscord) }
  var skey by remember(initSkey) { mutableStateOf(initSkey) }
  // No local autostart toggle here: GatewaySection owns it (immediate-save).
  // Save passes vm.autostart() through so this section never overwrites it.
  val connScope = rememberCoroutineScope()
  var keyCheck by remember { mutableStateOf<String?>(null) }
  var keyOk by remember { mutableStateOf<Boolean?>(null) }
  var checkingKey by remember { mutableStateOf(false) }
  val ctx = LocalContext.current

  // Install outcome toasts (vm.install() is async; skip the initial state).
  var prevInstall by remember { mutableStateOf(install) }
  LaunchedEffect(install) {
    if (install != prevInstall) {
      when {
        prevInstall == InstallState.INSTALLING && install == InstallState.INSTALLED ->
          Toast.makeText(ctx, "installed — press Start", Toast.LENGTH_SHORT).show()
        prevInstall == InstallState.INSTALLING && install == InstallState.FAILED ->
          Toast.makeText(ctx, "install failed — reason shown below", Toast.LENGTH_LONG).show()
      }
      prevInstall = install
    }
  }

  Column(Modifier.fillMaxWidth()) {
    // Status header lines (root already prints // CONNECTION, no dup header).
    Text("Hermes Mobile v" + BuildConfig.VERSION_NAME, color = TextPrimary, fontSize = 18.sp,
      fontWeight = FontWeight.Bold)
    Text("on-phone gateway · no default key · use a separate telegram bot from your PC",
      color = TextSecondary, fontSize = 12.sp)
    Text("state: $install", color = NeonCyan, fontSize = 12.sp,
      fontFamily = FontFamily.Monospace)
    if (install == InstallState.FAILED) Text(
      "install failed: ${installError ?: "unknown error"} — fix and press Retry",
      color = NeonRed, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    if (progress.isNotBlank()) Text(progress, color = TextSecondary,
      fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(10.dp))

    // Provider picker + API key + tri-state Test-key button.
    ConnProviderPicker(provider) { provider = it; keyCheck = null; keyOk = null }
    ConnSecretField(key, { key = it; keyCheck = null; keyOk = null }, "provider API key")
    Row(modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(
        onClick = {
          // Freeze the live field values at press time (Test never saves).
          val liveProvider = provider
          val liveKey = key.trim()
          val liveSkey = skey
          checkingKey = true
          keyCheck = null
          keyOk = null
          if (!connected) {
            checkingKey = false
            keyOk = false
            keyCheck = "gateway offline — press Start first, then test"
          } else if (liveProvider.isBlank()) {
            checkingKey = false
            keyOk = false
            keyCheck = "pick a provider (or enter a custom id) first — not saved"
          } else connScope.launch {
            try {
              val slug = connNormProvider(liveProvider)
              val okResult = GatewayClient(apiKey = { liveSkey })
                .providersValidate(slug,
                  MobileGatewayService.providerKeyEnv(slug), liveKey)
              keyOk = okResult
              keyCheck = when (okResult) {
                true -> "key OK (not saved — press Save to keep it)"
                false -> "key rejected by gateway (not saved)"
                null -> "couldn't verify live — not saved, try chatting"
              }
            } catch (e: Exception) {
              keyOk = null
              keyCheck = "couldn't verify live — not saved, try chatting"
            } finally {
              checkingKey = false
            }
          }
        },
        enabled = key.isNotBlank() && !checkingKey
      ) { Text(if (checkingKey) "Testing..." else "Test key", fontSize = 13.sp) }
      keyCheck?.let {
        Text(it,
          modifier = Modifier.weight(1f),
          color = when (keyOk) {
            true -> NeonGreen
            false -> NeonRed
            null -> NeonAmber
          },
          fontSize = 12.sp, fontFamily = FontFamily.Monospace)
      }
    }
    Spacer(Modifier.height(8.dp))

    // Model / base URL / messaging tokens / local gateway key.
    ConnField(model, { model = it }, "model id (optional)")
    ConnField(baseUrl, { baseUrl = it }, "base URL (only for custom endpoints)")
    ConnSecretField(tg, { tg = it }, "telegram bot token (separate bot)")
    ConnSecretField(discord, { discord = it }, "discord token (optional)")
    ConnSecretField(skey, { skey = it }, "local api key (optional)")

    // Validation hint + Save/Install buttons.
    // Autostart lives in GatewaySection (single source, immediate-save);
    // pass vm.autostart() through so this section never overwrites it.
    val ok = connKeysValid(provider, key, baseUrl)
    if (!ok) Text(
      if (key.isBlank()) "API key is required."
      else if (provider.isBlank()) "Custom provider id is required (or pick from the list)."
      else "Unknown provider: a custom base URL is required.",
      color = NeonAmber, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(4.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(
        onClick = {
          try {
            vm.saveKeys(provider, key, model, baseUrl, tg, discord, skey, vm.autostart())
            SettingsPrefsTick.bump()
            Toast.makeText(ctx, "keys saved", Toast.LENGTH_SHORT).show()
          } catch (e: Exception) {
            Toast.makeText(ctx, "save failed: ${e.message}", Toast.LENGTH_LONG).show()
          }
        },
        enabled = ok,
        colors = ButtonDefaults.buttonColors(containerColor = NeonViolet,
          contentColor = Color.White)
      ) { Text("Save") }
      Button(
        onClick = {
          try {
            vm.saveKeys(provider, key, model, baseUrl, tg, discord, skey, vm.autostart())
            SettingsPrefsTick.bump()
            vm.install()
            Toast.makeText(ctx, "install started…", Toast.LENGTH_SHORT).show()
          } catch (e: Exception) {
            Toast.makeText(ctx, "install failed to start: ${e.message}", Toast.LENGTH_LONG).show()
          }
        },
        enabled = ok && (install == InstallState.NOT_INSTALLED ||
          install == InstallState.INSTALLED || install == InstallState.FAILED),
        colors = ButtonDefaults.buttonColors(containerColor = NeonViolet,
          contentColor = Color.White)
      ) { Text(if (install == InstallState.FAILED) "Retry" else "Install") }
    }
    Spacer(Modifier.height(4.dp))
    Text("Install downloads the prebuilt image once (~305MB) then runs.",
      color = TextSecondary, fontSize = 12.sp)
  }
}
