//! OpenClaw Gateway 任务连接器：设备签名握手 + `tasks.list` 拉取 + 本地任务账本。
//!
//! 目标：把 VPS / 本机 OpenClaw Gateway 的后台任务台账（ACP / subagent / cron /
//! CLI 四类运行）接入 Metrik 的任务追踪页。官方台账终态记录只保留 7 天，
//! 本模块把每次快照落入自建账本表，突破保留期，支持 26 周任务历史。
//!
//! 协议要点（2026-09-15 按 docs/gateway/protocol.md + 本机 dist 源码 +
//! 原始 WS 帧实测钉死）：
//! - 文本帧 JSON：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`；
//! - 首帧必须是 `connect`；网关先推 `connect.challenge` 事件（payload.nonce）；
//! - 设备签名载荷 v3：`v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|
//!   token|nonce|platform|deviceFamily`，Ed25519（ring）签名 base64url；
//! - client.id / client.mode 有服务端白名单（cli/ui/backend/probe/test…）；
//! - 同进程回环 + 共享 token + 设备身份 → 自动批准（本机实测）；
//!   远程（VPS）连接需在网关侧 `openclaw devices approve` 一次；
//! - `tasks.list` 需要 `operator.read`；返回 `{tasks:[...]}`；
//!   `tasks.get` 参数是 `taskId`（不是文档 CLI 篇的 lookup）；
//! - `chat.history` 需要 `operator.admin`（2026-10-03 实测：会话消息流，Control UI
//!   同款接口）——会话工作台账用它取"群聊派活原话"当标题；设备对 admin 自动获准；
//! - 无 tasks.flow RPC；TaskFlow 编排状态不在本连接器范围（CLI 专用）。
//!
//! 隐私边界：任务账本只存任务元数据（id / 标题 / 状态 / 时间 / 会话键），
//! 不存 prompt、回复正文、工具输出与凭据；token 与设备私钥只在内存使用。
//! 会话工作台账（session_run）按用户明确要求存"派活原话"前 200 字作标题、
//! 最近一次工具调用名作进度——仅本地落盘，永不上传；完整正文与工具输出仍不落。

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::params_from_iter;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::Message;

/// 单次连接内 RPC 往返超时。快照节奏 60s（展开视图 1 分钟刷新），
/// 单次拉取必须远小于它。
const RPC_TIMEOUT: Duration = Duration::from_secs(8);
/// 握手总预算（含 challenge 等待）。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// 采集配置与身份
// ---------------------------------------------------------------------------

/// 一个被追踪的 Gateway。Metrik 可同时追踪多个（本机 + 多台 VPS）。
#[derive(Clone, Debug)]
pub struct GatewayTarget {
    /// 展示名（如 "本机"、"VPS-hetzner"），只用于 UI 与账本 owner 列。
    pub label: String,
    /// ws:// 或 wss:// 端点，如 ws://127.0.0.1:18789。
    pub url: String,
    /// 网关共享 token（gateway.auth.mode=token）。
    pub token: String,
    /// 设备身份目录：内含 identity/device.json（deviceId + Ed25519 PEM）。
    /// 本机传 None → 用默认 state 目录的探测身份（无则自动生成）。
    pub identity_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct DeviceIdentity {
    device_id: String,
    /// PKCS#8 DER：ring 重建 keypair 的直接来源（签名内部用 seed）。
    private_key_der: Vec<u8>,
    /// 原始 32 字节公钥（握手 device.publicKey 用 base64url 形态发出）。
    /// 注意：v1 DER 里的 32B 是 seed 不是公钥，必须经 ring 推导。
    public_key_raw: [u8; 32],
}

/// OpenClaw deviceId 形态：sha256(rawPubKey) 的小写 hex（64 字符）。
/// 由本机两份真实配对身份推导并双样本验证。
fn sha256_hex(data: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, data);
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn base64url(data: &[u8]) -> String {
    // URL-safe 且无 padding：OpenClaw 的 deviceId 是 Ed25519 公钥
    // （32 字节）的 43 字符 base64url，不带 '='。与本机实测配对记录一致。
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[n as usize & 63] as char);
        }
    }
    out
}

fn load_or_create_identity(identity_dir: &Path) -> Result<DeviceIdentity> {
    let path = identity_dir.join("identity").join("device.json");
    if path.exists() {
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)
            .context("device.json is not valid JSON")?;
        let private_key_der = match value.get("privateKeyDerB64").and_then(Value::as_str) {
            Some(der_b64) => base64_decode(der_b64)
                .context("device.json privateKeyDerB64 is not valid base64")?,
            // 旧版/OpenClaw 生成的文件只有 PEM 字段：解码出 DER 直接使用
            // （公钥提取兼容 v1 48B 嵌套与 v2 83B 两种形态）。
            None => {
                let pem = value
                    .get("privateKeyPem")
                    .and_then(Value::as_str)
                    .context("device.json has neither privateKeyDerB64 nor privateKeyPem")?;
                pem_to_der(pem).context("device.json privateKeyPem is not valid PEM")?
            }
        };
        // 公钥来源分形态：v2 DER 内嵌公钥直接提取；v1 DER 只有 seed，
        // 从同文件 publicKeyPem（SPKI 尾 32B）取真公钥。
        let public_raw = match ed25519_public_from_pkcs8(&private_key_der) {
            Ok(raw) => raw,
            Err(_) => {
                let spki_pem = value
                    .get("publicKeyPem")
                    .and_then(Value::as_str)
                    .context("v1 identity lacks embedded pubkey; publicKeyPem required")?;
                let spki_der =
                    pem_to_der(spki_pem).context("device.json publicKeyPem is not valid PEM")?;
                let spki_len = spki_der.len();
                if spki_len < 32 {
                    bail!("SPKI DER shorter than 32 bytes");
                }
                spki_der[spki_len - 32..].to_vec()
            }
        };
        let mut key = [0u8; 32];
        key.copy_from_slice(&public_raw);
        return Ok(DeviceIdentity {
            device_id: sha256_hex(&key),
            private_key_der,
            public_key_raw: key,
        });
    }

    // 生成新身份（Ed25519 PKCS#8 PEM）。OpenClaw 的 device.json 用同构格式
    // （version / deviceId / privateKeyDerB64 / createdAtMs），公钥/ID 从 DER 提取。
    // ring 0.17：generate_pkcs8 返回 Result<Document, Unspecified>，错误类型
    // 不实现 std::error::Error，不能 .context()，只能 map_err 转 anyhow。
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|error| anyhow!("Ed25519 keygen failed: {error}"))?;
    let pkcs8_bytes = pkcs8.as_ref();
    // 自检：确保私钥可加载（不使用 keypair 对象本身，公钥从 DER 提取）。
    ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8_bytes)
        .map_err(|error| anyhow!("generated key failed to load: {error}"))?;
    // ring 0.17：public_key() 已私有化，从 PKCS#8 DER 尾部取 raw 公钥
    // （Ed25519 PKCS#8 固定 16 字节头 + 32 字节 key，总长 48）。
    let public_raw = ed25519_public_from_pkcs8(pkcs8_bytes)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let created = chrono::Utc::now().timestamp_millis();
    let store = json!({
        "version": 1,
        "deviceId": sha256_hex(&public_raw),
        "privateKeyDerB64": base64url(pkcs8_bytes),
        "createdAtMs": created,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&store)?)
        .with_context(|| format!("write {}", path.display()))?;

    let mut key = [0u8; 32];
    key.copy_from_slice(&public_raw);
    Ok(DeviceIdentity {
        device_id: sha256_hex(&key),
        private_key_der: pkcs8_bytes.to_vec(),
        public_key_raw: key,
    })
}

/// 从 Ed25519 私钥 DER 提取 raw 公钥。DER 可能是 48 字节 PKCS#8（ring 生成，
/// 头 302e…04220420），也可能带 V3 扩展形态（长度字节不同）——不硬编码前缀，
/// 改为按 ASN.1 定位 OCTET STRING，取其中 32 字节 Ed25519 公钥。
fn ed25519_public_from_pkcs8(der: &[u8]) -> Result<Vec<u8>> {
    // 83B v2（我们自己生成的身份）：公钥在固定 offset 51..83
    // （ring 0.17.14 ed25519_pkcs8_v2_template.der 布局，源码铁证）。
    // 48B v1（OpenClaw 旧身份）：此处只有 seed，没有公钥——公钥从身份
    // 文件的 publicKeyPem（SPKI 尾 32B）获取，见 load_or_create_identity。
    if der.len() == 83 && der[48] == 0x81 && der[49] == 0x21 && der[50] == 0x00 {
        return Ok(der[51..83].to_vec());
    }
    bail!(
        "no public key embedded in this DER form (len={}); use publicKeyPem from the identity file",
        der.len()
    );
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const REV: fn(u8) -> Option<u8> = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let bytes: Vec<u8> = text.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut n: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            let v = REV(*c)?;
            n |= (v as u32) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// PEM 文本 → DER 字节（去头尾行与空白后 base64 解码）。
fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|line| !line.contains("-----"))
        .collect::<Vec<_>>()
        .join("");
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    base64_decode(&body)
}

/// 握手签名参数：v3 载荷的非常量部分（clippy too_many_arguments 阈值 7）。
struct SignContext<'a> {
    client_id: &'a str,
    client_mode: &'a str,
    role: &'a str,
    scopes: &'a [&'a str],
    signed_at_ms: i64,
    token: &'a str,
    nonce: &'a str,
    platform: &'a str,
    device_family: &'a str,
}

fn sign_payload_v3(identity: &DeviceIdentity, ctx: &SignContext) -> Result<String> {
    let payload = [
        "v3",
        &identity.device_id,
        ctx.client_id,
        ctx.client_mode,
        ctx.role,
        &ctx.scopes.join(","),
        &ctx.signed_at_ms.to_string(),
        ctx.token,
        ctx.nonce,
        &ctx.platform.to_ascii_lowercase(),
        &ctx.device_family.to_ascii_lowercase(),
    ]
    .join("|");
    let pair =
        ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&identity.private_key_der)
            .map_err(|error| anyhow!("bad Ed25519 private key: {error}"))?;
    let sig = pair.sign(payload.as_bytes());
    Ok(base64url(sig.as_ref()))
}

// ---------------------------------------------------------------------------
// WS 客户端（同步 tungstenite）
// ---------------------------------------------------------------------------

struct GatewayClient {
    socket: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    next_id: u32,
}

impl GatewayClient {
    fn connect(target: &GatewayTarget, identity: &DeviceIdentity) -> Result<Self> {
        let start = Instant::now();
        let request = target
            .url
            .clone()
            .into_client_request()
            .context("bad gateway url")?;
        let (mut socket, _response) = tungstenite::connect(request)
            .map_err(|error| anyhow!("gateway connect failed: {error}"))?;

        // 1) 等待 connect.challenge，取 nonce
        let nonce = Self::wait_challenge(&mut socket, start)?;
        let signed_at_ms = chrono::Utc::now().timestamp_millis();
        // admin 会话：chat.history（会话工作台账的标题/进度源）需要 operator.admin。
        // 网关按设备授权取交集；仅授 read 时本握手仍成功，chat.history 调用会
        // FORBIDDEN → record_session_runs 静默降级（标题空，前端显示兜底标签）。
        let scopes = ["operator.read", "operator.admin"];
        let signature = sign_payload_v3(
            identity,
            &SignContext {
                client_id: "cli",
                client_mode: "cli",
                role: "operator",
                scopes: &scopes,
                signed_at_ms,
                token: &target.token,
                nonce: &nonce,
                platform: "windows",
                device_family: "",
            },
        )?;

        // 2) connect 握手（client.id/mode 必须在服务端白名单内）
        Self::send(
            &mut socket,
            &json!({
                "type": "req",
                "id": "connect-1",
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 4,
                    "client": {"id": "cli", "version": "1.0.0", "platform": "windows", "mode": "cli"},
                    "role": "operator",
                    "scopes": scopes,
                    "caps": [],
                    "commands": [],
                    "permissions": {},
                    "auth": {"token": target.token},
                    "locale": "zh-CN",
                    "userAgent": "metrik/1.0",
                    "device": {
                        "id": identity.device_id,
                        "publicKey": base64url(&identity.public_key_raw),
                        "signature": signature,
                        "signedAt": signed_at_ms,
                        "nonce": nonce,
                    }
                }
            }),
        )?;
        let hello = Self::wait_response(&mut socket, start, "connect-1")?;
        let ok = hello.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if !ok {
            let message = hello
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            bail!("gateway handshake rejected: {message}");
        }
        let scopes = hello
            .pointer("/payload/auth/scopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !scopes.iter().any(|scope| scope == "operator.read") {
            bail!(
                "gateway granted scopes [{scopes:?}] without operator.read; \
                 approve this device once via `openclaw devices approve`"
            );
        }

        Ok(Self { socket, next_id: 1 })
    }

    fn wait_challenge(
        socket: &mut tungstenite::WebSocket<
            tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
        >,
        start: Instant,
    ) -> Result<String> {
        loop {
            if start.elapsed() > HANDSHAKE_TIMEOUT {
                bail!("timed out waiting for connect.challenge");
            }
            match socket.read()? {
                Message::Text(text) => {
                    let value: Value =
                        serde_json::from_str(&text).context("non-JSON gateway frame")?;
                    if value.get("type").and_then(Value::as_str) == Some("event")
                        && value.get("event").and_then(Value::as_str) == Some("connect.challenge")
                    {
                        return value
                            .pointer("/payload/nonce")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .context("challenge missing nonce");
                    }
                    // 其它 pre-connect 帧忽略
                }
                Message::Ping(data) => socket.send(Message::Pong(data))?,
                Message::Close(frame) => {
                    bail!("gateway closed during challenge: {frame:?}")
                }
                _ => {}
            }
        }
    }

    fn send(
        socket: &mut tungstenite::WebSocket<
            tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
        >,
        value: &Value,
    ) -> Result<()> {
        socket
            .send(Message::text(serde_json::to_string(value)?))
            .map_err(|error| anyhow!("gateway send failed: {error}"))
    }

    fn wait_response(
        socket: &mut tungstenite::WebSocket<
            tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
        >,
        start: Instant,
        request_id: &str,
    ) -> Result<Value> {
        loop {
            if start.elapsed() > HANDSHAKE_TIMEOUT + RPC_TIMEOUT {
                bail!("gateway response timed out");
            }
            match socket.read()? {
                Message::Text(text) => {
                    let value: Value =
                        serde_json::from_str(&text).context("non-JSON gateway frame")?;
                    let is_ours = value.get("type").and_then(Value::as_str) == Some("res")
                        && value.get("id").and_then(Value::as_str) == Some(request_id);
                    if is_ours {
                        return Ok(value);
                    }
                    // event / 其它 id 的 res（本协议串行调用，罕见）忽略
                }
                Message::Ping(data) => socket.send(Message::Pong(data))?,
                Message::Close(frame) => bail!("gateway closed mid-call: {frame:?}"),
                _ => {}
            }
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let request_id = format!("m-{}", self.next_id);
        self.next_id += 1;
        let start = Instant::now();
        Self::send(
            &mut self.socket,
            &json!({"type": "req", "id": request_id, "method": method, "params": params}),
        )?;
        // wait_response 内部已循环等帧，这里单次取回即可。
        let value = Self::wait_response(&mut self.socket, start, &request_id)?;
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(value.get("payload").cloned().unwrap_or(Value::Null))
        } else {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown gateway error");
            bail!("rpc {method} failed: {message}");
        }
    }
}

impl Drop for GatewayClient {
    fn drop(&mut self) {
        let _ = self.socket.close(None);
    }
}

// ---------------------------------------------------------------------------
// 任务记录模型（官方 tasks.list 字段子集）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTask {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub child_session_key: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub terminal_summary: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// 运行中任务的一句话进度（网关 tasks.list 的 progressSummary，原话透传）。
    #[serde(default)]
    pub progress_summary: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// 一次拉取的结果：全部快照任务 + 观测时间。
/// 单个 Agent 的活动快照（从 Gateway agents.list / sessions.list 提取）。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub agent_id: String,
    pub name: Option<String>,
    /// 该 Agent 当前是否被认为"活跃"（有未结束会话或近 N 秒有活动）。
    pub active: bool,
    /// 最后活动时间（ms）。来源视网关返回而定：会话 updated_at / lastActivity。
    pub last_active_ms: Option<i64>,
    /// 活跃会话数。
    pub session_count: i64,
    /// 当前运行中任务数（tasks.list 里该 agent 的 running/queued）。
    pub running_tasks: i64,
}

pub struct AgentsSnapshot {
    #[allow(dead_code)] // 预留给后续 UI 显示"更新于"时间戳
    pub collected_at_ms: i64,
    pub agents: Vec<AgentActivity>,
    /// 会话级用量/上下文明细（B 链路：token 用量与上下文水位的数据源）。
    pub sessions: Vec<SessionUsage>,
}

/// 单个会话的用量快照（sessions.list 字段子集）。
/// 实测（2026-10-02）：input/output/totalTokens 依赖网关 effectiveResponseUsage
/// 开关（北斗 VPS 关闭时恒为 0）；上下文水位 estimatedPromptTokens/
/// contextTokenBudget 只在跑过 run 的会话上携带，空闲会话缺失。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub key: String,
    pub gateway: String,
    pub agent_id: Option<String>,
    /// 是否群会话（北斗接力跳所在形态：agent:<id>:feishu:group:<chatId>）。
    pub is_group: bool,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub context_tokens: Option<i64>,
    /// 当前上下文填充估算（pre-prompt-estimate，空闲会话缺省）。
    pub estimated_prompt_tokens: Option<i64>,
    /// 上下文预算（模型窗口 - 预留）。
    pub context_token_budget: Option<i64>,
    pub prompt_message_count: Option<i64>,
    pub should_compact: Option<bool>,
    pub has_active_run: bool,
    pub status: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub runtime_ms: Option<i64>,
    pub updated_at: Option<i64>,
    pub subject: Option<String>,
    /// 最近一次 run 的错误原话（会话 status=failed 时携带；台账失败行透传）。
    pub last_run_error: Option<String>,
}

/// 拉 Agent 活动快照。
/// 主数据源 = sessions.list（实测返回每个会话的 key/status/hasActiveRun/
/// updatedAt/tokens，key 形如 agent:<agentId>[:subagent:<uuid>]）；辅以
/// agents.list 补全 Agent 显示名。会话按 agentId 前缀归集成各 Agent 活动卡。
/// 传入 connection 时顺带把会话 run 增量记入本地台账（群聊派活的数据源）；
/// connection 传 None 仅拉快照（测试/无账本场景）。
pub fn fetch_agents_snapshot(
    target: &GatewayTarget,
    connection: Option<&Connection>,
    options: &SessionLedgerOptions,
) -> Result<AgentsSnapshot> {
    let identity_dir = match &target.identity_dir {
        Some(dir) => dir.clone(),
        None => default_state_dir(),
    };
    let identity = load_or_create_identity(&identity_dir)?;
    let mut client = GatewayClient::connect(target, &identity)?;

    let sessions_payload = client.call("sessions.list", json!({}))?;
    let agents_payload = client.call("agents.list", json!({}))?;

    let mut agents: Vec<AgentActivity> = agents_payload
        .pointer("/agents")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| AgentActivity {
                    agent_id: value
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    name: value.get("name").and_then(Value::as_str).map(str::to_owned),
                    active: false,
                    last_active_ms: None,
                    session_count: 0,
                    running_tasks: 0,
                })
                .filter(|agent| !agent.agent_id.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 会话归集：key 形如 agent:<agentId>[:subagent:...]。主会话与 subagent
    // 会话都计入所属 Agent 的活动。
    let mut session_usages: Vec<SessionUsage> = Vec::new();
    if let Some(sessions) = sessions_payload.get("sessions").and_then(Value::as_array) {
        for session in sessions {
            let key = session.get("key").and_then(Value::as_str).unwrap_or("");
            let Some(agent_id) = key.strip_prefix("agent:") else {
                continue;
            };
            let agent_id = agent_id.split(':').next().unwrap_or("");
            if agent_id.is_empty() {
                continue;
            }
            let Some(agent) = agents.iter_mut().find(|agent| agent.agent_id == agent_id) else {
                continue;
            };
            agent.session_count += 1;
            if let Some(updated) = session.get("updatedAt").and_then(Value::as_i64) {
                if agent
                    .last_active_ms
                    .map(|current| updated > current)
                    .unwrap_or(true)
                {
                    agent.last_active_ms = Some(updated);
                }
            }
            let has_active_run = session
                .get("hasActiveRun")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let status_running = session.get("status").and_then(Value::as_str) == Some("running");
            if has_active_run || status_running {
                agent.running_tasks += 1;
                agent.active = true;
            }

            // B 链路：用量/上下文字段提取（缺省字段留 None，前端显示"—"）。
            let budget = session.get("contextBudgetStatus");
            session_usages.push(SessionUsage {
                key: key.to_owned(),
                gateway: target.label.clone(),
                agent_id: Some(agent_id.to_owned()),
                is_group: session.get("peerKind").and_then(Value::as_str) == Some("group")
                    || key.contains(":feishu:group:"),
                model: session
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                model_provider: session
                    .get("modelProvider")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input_tokens: session.get("inputTokens").and_then(Value::as_i64),
                output_tokens: session.get("outputTokens").and_then(Value::as_i64),
                total_tokens: session.get("totalTokens").and_then(Value::as_i64),
                context_tokens: session.get("contextTokens").and_then(Value::as_i64),
                estimated_prompt_tokens: budget
                    .and_then(|b| b.get("estimatedPromptTokens"))
                    .and_then(Value::as_i64),
                context_token_budget: budget
                    .and_then(|b| b.get("contextTokenBudget"))
                    .and_then(Value::as_i64)
                    .or_else(|| session.get("contextTokens").and_then(Value::as_i64)),
                prompt_message_count: budget
                    .and_then(|b| b.get("messageCount"))
                    .and_then(Value::as_i64),
                should_compact: budget
                    .and_then(|b| b.get("shouldCompact"))
                    .and_then(Value::as_bool),
                has_active_run: has_active_run || status_running,
                status: session
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                started_at: session.get("startedAt").and_then(Value::as_i64),
                ended_at: session.get("endedAt").and_then(Value::as_i64),
                runtime_ms: session.get("runtimeMs").and_then(Value::as_i64),
                updated_at: session.get("updatedAt").and_then(Value::as_i64),
                subject: session
                    .get("subject")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                last_run_error: session
                    .get("lastRunError")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }

    // 会话工作台账：群聊派活等会话 run 增量落本地（详见 record_session_runs）。
    // 记账失败不拖垮快照——台账缺失只影响任务面板的会话行，不影响用量链路。
    if let Some(connection) = connection {
        let _ = record_session_runs(
            connection,
            &target.label,
            &session_usages,
            Some(&mut client),
            options,
        );
    }

    Ok(AgentsSnapshot {
        collected_at_ms: chrono::Utc::now().timestamp_millis(),
        agents,
        sessions: session_usages,
    })
}

pub struct TasksSnapshot {
    pub collected_at_ms: i64,
    pub tasks: Vec<GatewayTask>,
}

pub fn fetch_tasks(target: &GatewayTarget) -> Result<TasksSnapshot> {
    let identity_dir = match &target.identity_dir {
        Some(dir) => dir.clone(),
        None => default_state_dir(),
    };
    let identity = load_or_create_identity(&identity_dir)?;
    let mut client = GatewayClient::connect(target, &identity)?;
    let payload = client.call("tasks.list", json!({}))?;
    let tasks = payload
        .get("tasks")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| serde_json::from_value::<GatewayTask>(value.clone()).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(TasksSnapshot {
        collected_at_ms: chrono::Utc::now().timestamp_millis(),
        tasks,
    })
}

fn default_state_dir() -> PathBuf {
    std::env::var_os("OPENCLAW_STATE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".openclaw"))
}

// ---------------------------------------------------------------------------
// 本地任务账本（突破官方 7 天保留）
// ---------------------------------------------------------------------------

/// 终态集合：落账的终态保护共用这一份判定，别再复制 matches! 列表。
fn is_terminal_status(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("succeeded") | Some("failed") | Some("timed_out") | Some("cancelled") | Some("lost")
    )
}

/// 每次快照把观察到的任务 upsert 进本地账本：
/// - 运行中任务更新时间戳；终态任务落最终状态后不再被旧快照覆盖（观察合并
///   取"更完整"的记录：ended_at 补齐即视为更完整）。
/// - 不删除任何记录：任务历史永久保留（这是本表存在的意义）。
pub fn upsert_tasks(
    connection: &Connection,
    target_label: &str,
    snapshot: &TasksSnapshot,
) -> Result<usize> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS gateway_task (
            task_id        TEXT NOT NULL,
            gateway        TEXT NOT NULL,
            runtime        TEXT,
            kind           TEXT,
            status         TEXT,
            title          TEXT,
            label          TEXT,
            agent_id       TEXT,
            session_key    TEXT,
            child_session_key TEXT,
            run_id         TEXT,
            created_at_ms  INTEGER,
            started_at_ms  INTEGER,
            ended_at_ms    INTEGER,
            updated_at_ms  INTEGER,
            terminal_summary TEXT,
            error          TEXT,
            progress_summary TEXT,
            first_seen_ms  INTEGER NOT NULL,
            last_seen_ms   INTEGER NOT NULL,
            PRIMARY KEY (task_id, gateway)
        );
        CREATE INDEX IF NOT EXISTS idx_gateway_task_gateway_time
            ON gateway_task(gateway, first_seen_ms);",
    )?;
    // 老账本补列：progress_summary 是后加字段，已有库 ALTER 补上
    //（新库建表已带列，ALTER 报 duplicate column 直接忽略）。
    let _ = connection.execute_batch("ALTER TABLE gateway_task ADD COLUMN progress_summary TEXT");
    let mut written = 0usize;
    for task in &snapshot.tasks {
        let task_id = match task.task_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => id,
            None => continue,
        };
        let status = task.status.as_deref();
        let has_terminal = is_terminal_status(status);
        // 终态保护：已落终态的行不被非终态快照回退（任务台账以官方为权威，
        // 但本地观测可能乱序到达——重连后 list 可能先给旧的 running 再给终态）。
        let existing_terminal: Option<Option<String>> = connection
            .query_row(
                "SELECT status FROM gateway_task WHERE task_id = ?1 AND gateway = ?2",
                rusqlite::params![task_id, target_label],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok();
        if let Some(Some(stored_status)) = existing_terminal {
            let stored_is_terminal = is_terminal_status(Some(stored_status.as_str()));
            if stored_is_terminal && !has_terminal {
                continue;
            }
        }
        connection.execute(
            "INSERT INTO gateway_task (
                task_id, gateway, runtime, kind, status, title, label, agent_id,
                session_key, child_session_key, run_id,
                created_at_ms, started_at_ms, ended_at_ms, updated_at_ms,
                terminal_summary, error, progress_summary, first_seen_ms, last_seen_ms
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
            ON CONFLICT(task_id, gateway) DO UPDATE SET
                runtime = COALESCE(excluded.runtime, runtime),
                kind = COALESCE(excluded.kind, kind),
                status = excluded.status,
                title = COALESCE(excluded.title, title),
                label = COALESCE(excluded.label, label),
                agent_id = COALESCE(excluded.agent_id, agent_id),
                session_key = COALESCE(excluded.session_key, session_key),
                child_session_key = COALESCE(excluded.child_session_key, child_session_key),
                run_id = COALESCE(excluded.run_id, run_id),
                created_at_ms = COALESCE(created_at_ms, excluded.created_at_ms),
                started_at_ms = COALESCE(started_at_ms, excluded.started_at_ms),
                ended_at_ms = COALESCE(excluded.ended_at_ms, ended_at_ms),
                updated_at_ms = COALESCE(excluded.updated_at_ms, updated_at_ms),
                terminal_summary = COALESCE(excluded.terminal_summary, terminal_summary),
                error = COALESCE(excluded.error, error),
                progress_summary = COALESCE(excluded.progress_summary, progress_summary),
                last_seen_ms = excluded.last_seen_ms",
            rusqlite::params![
                task_id,
                target_label,
                task.runtime,
                task.kind,
                task.status,
                task.title,
                task.label,
                task.agent_id,
                task.session_key,
                task.child_session_key,
                task.run_id,
                task.created_at,
                task.started_at,
                task.ended_at,
                task.updated_at,
                task.terminal_summary,
                task.error,
                task.progress_summary,
                snapshot.collected_at_ms,
                snapshot.collected_at_ms,
            ],
        )?;
        written += 1;
    }
    Ok(written)
}

/// 一次完整的任务快照：连接 → 拉取 → 落账本。供 lib.rs 的刷新命令调用。
pub fn snapshot_gateway_tasks(connection: &Connection, target: &GatewayTarget) -> Result<usize> {
    let snapshot = fetch_tasks(target)?;
    upsert_tasks(connection, &target.label, &snapshot)
}

/// 快照节流：同一网关 MIN_INTERVAL_MS 内的重复调用直接复用上次结果，
/// 避免前端 3 秒节拍叠加多个视图时对网关发起过量握手。
const SNAPSHOT_MIN_INTERVAL_MS: i64 = 2500;

pub fn snapshot_gateway_tasks_throttled(
    connection: &Connection,
    target: &GatewayTarget,
    last_fetch_ms: &mut Option<(String, Instant)>,
) -> Result<usize> {
    if let Some((label, at)) = last_fetch_ms {
        if label == &target.label
            && at.elapsed() < Duration::from_millis(SNAPSHOT_MIN_INTERVAL_MS as u64)
        {
            // 视为成功但不重新拉网关；账本内容仍是新鲜的（上一拍刚写过）。
            return Ok(0);
        }
    }
    let written = snapshot_gateway_tasks(connection, target)?;
    *last_fetch_ms = Some((target.label.clone(), Instant::now()));
    Ok(written)
}

// ---------------------------------------------------------------------------
// 账本查询（任务页数据源）
// ---------------------------------------------------------------------------

/// 任务页一行的视图记录（serde 序列化后直接给前端）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTaskRow {
    pub task_id: String,
    pub gateway: String,
    pub runtime: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub title: Option<String>,
    pub label: Option<String>,
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub child_session_key: Option<String>,
    pub run_id: Option<String>,
    pub created_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub terminal_summary: Option<String>,
    pub error: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub progress_summary: Option<String>,
}

/// 读本地任务账本：按 last_seen 倒序，可选状态过滤与行数上限。
/// status 传 "active" 查运行中（queued/running），传具体终态查对应终态。
pub fn list_tasks(
    connection: &Connection,
    status: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<GatewayTaskRow>> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS gateway_task (
            task_id        TEXT NOT NULL,
            gateway        TEXT NOT NULL,
            runtime        TEXT,
            kind           TEXT,
            status         TEXT,
            title          TEXT,
            label          TEXT,
            agent_id       TEXT,
            session_key    TEXT,
            child_session_key TEXT,
            run_id         TEXT,
            created_at_ms  INTEGER,
            started_at_ms  INTEGER,
            ended_at_ms    INTEGER,
            updated_at_ms  INTEGER,
            terminal_summary TEXT,
            error          TEXT,
            progress_summary TEXT,
            first_seen_ms  INTEGER NOT NULL,
            last_seen_ms   INTEGER NOT NULL,
            PRIMARY KEY (task_id, gateway)
        );",
    )?;
    let limit = limit.unwrap_or(200).min(2000);
    let active_filter = "status IN ('queued','running')";
    let (where_clause, params): (&str, Vec<&str>) = match status {
        Some("active") => (active_filter, vec![]),
        Some(status) => ("status = ?1", vec![status]),
        None => ("1=1", vec![]),
    };
    let sql = format!(
        "SELECT task_id, gateway, runtime, kind, status, title, label, agent_id, \
         session_key, child_session_key, run_id, created_at_ms, started_at_ms, \
         ended_at_ms, updated_at_ms, terminal_summary, error, first_seen_ms, last_seen_ms, \
         progress_summary \
         FROM gateway_task WHERE {where_clause} \
         ORDER BY COALESCE(updated_at_ms, last_seen_ms) DESC LIMIT {limit}"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(GatewayTaskRow {
            task_id: row.get(0)?,
            gateway: row.get(1)?,
            runtime: row.get(2)?,
            kind: row.get(3)?,
            status: row.get(4)?,
            title: row.get(5)?,
            label: row.get(6)?,
            agent_id: row.get(7)?,
            session_key: row.get(8)?,
            child_session_key: row.get(9)?,
            run_id: row.get(10)?,
            created_at_ms: row.get(11)?,
            started_at_ms: row.get(12)?,
            ended_at_ms: row.get(13)?,
            updated_at_ms: row.get(14)?,
            terminal_summary: row.get(15)?,
            error: row.get(16)?,
            first_seen_ms: row.get(17)?,
            last_seen_ms: row.get(18)?,
            progress_summary: row.get(19)?,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 会话工作台账（群聊派活等会话 run 的结构化记录）
// ---------------------------------------------------------------------------

/// tasks.list 只登记 automation_run（cron）与 exec（CLI）两类任务；北斗矩阵群
/// 里 @星位派活 = 群会话 run，网关不生成 task 条目（2026-10-03 实测）。本表把
/// sessions.list 观察到的会话 run 增量落成台账：标题 = chat.history 最近一条
/// user 消息原话（用户明确批准；仅前 200 字，仅本地落盘），进度 = 最近一次
/// 工具调用名，成败/时长 = 会话字段。保留期对齐任务账本口径：7 天自动清理。
const SESSION_RUN_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// 从未观测到"运行中"的 run（两拍之间开始并结束的短 run）：结束时间在此窗口
/// 内的终态会话按漏采补记一行，同一结束时间戳只补一次。
const SESSION_RUN_MISSED_WINDOW_MS: i64 = 60 * 60 * 1000;
/// 比这更短的会话 run 不是真工作：sessions_send announce 唤醒会话产生的记账
/// 幻影（2026-10-03 实测 12~23ms 即被 superseded，模型运行时根本没起），
/// lastRun 指针会停在幻影上，把真实 run 的成败掩盖掉。不入账、不当失败。
const SESSION_RUN_MIN_RUNTIME_MS: i64 = 1000;

/// 会话台账的可调口径（设置页"任务追踪"→实时监控参数下发）：保留期与漏采
/// 补记窗口。幻影阈值是内部容错常量，不开放配置（调大吞真实短任务）。
#[derive(Clone, Copy, Debug)]
pub struct SessionLedgerOptions {
    pub retention_ms: i64,
    pub missed_window_ms: i64,
}

impl Default for SessionLedgerOptions {
    fn default() -> Self {
        Self {
            retention_ms: SESSION_RUN_RETENTION_MS,
            missed_window_ms: SESSION_RUN_MISSED_WINDOW_MS,
        }
    }
}

fn ensure_session_run_table(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_run (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            gateway       TEXT NOT NULL,
            session_key   TEXT NOT NULL,
            agent_id      TEXT,
            run_id        TEXT,
            title         TEXT,
            status        TEXT,
            error         TEXT,
            progress_summary TEXT,
            model         TEXT,
            started_at_ms INTEGER,
            ended_at_ms   INTEGER,
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_run_time
            ON session_run(gateway, first_seen_ms);",
    )?;
    Ok(())
}

/// 会话 run 状态 → 账本状态。sessions.list 的 status：running/done/failed
/// （空闲会话为 null）；终态落 done / failed，失败带 lastRunError 原话。
fn session_run_terminal_status(session: &SessionUsage) -> (&'static str, Option<String>) {
    if session.status.as_deref() == Some("failed") {
        ("failed", session.last_run_error.clone())
    } else {
        ("done", None)
    }
}

/// 低于最短时长的终态 run 视为 announce 幻影（见 SESSION_RUN_MIN_RUNTIME_MS）。
fn session_run_is_phantom(session: &SessionUsage) -> bool {
    session
        .runtime_ms
        .map(|ms| ms < SESSION_RUN_MIN_RUNTIME_MS)
        .unwrap_or(false)
}

/// 把快照里的会话 run 增量记入本地台账：
/// - hasActiveRun=true 且无开放行 → 新记一行"running"（started 取会话字段，缺省现在）；
/// - hasActiveRun=true 且已有开放行 → 刷新 last_seen / 标题 / 进度；
/// - hasActiveRun=false 且有开放行 → 落终态（failed 带错误原话；终态保护：
///   UPDATE 带 status='running' 条件，已关闭的行不被回写）；
/// - hasActiveRun=false 且从没见过开放行、但 endedAt 在漏采窗口内 → 按终态补记
///   （两拍之间开始并结束的短 run），同一 (session_key, ended_at) 只补一次。
///
/// chat.history 取标题/进度失败时静默降级——台账行仍在，只是标题空。
/// 返回本次写入（含新增与关闭）的行数。
fn record_session_runs(
    connection: &Connection,
    target_label: &str,
    sessions: &[SessionUsage],
    mut client: Option<&mut GatewayClient>,
    options: &SessionLedgerOptions,
) -> Result<usize> {
    ensure_session_run_table(connection)?;
    let now = chrono::Utc::now().timestamp_millis();
    let _ = connection.execute(
        "DELETE FROM session_run WHERE first_seen_ms < ?1",
        rusqlite::params![now - options.retention_ms],
    );
    let mut written = 0usize;
    for session in sessions {
        if session.key.is_empty() {
            continue;
        }
        let open: Option<i64> = connection
            .query_row(
                "SELECT id FROM session_run \
                 WHERE gateway = ?1 AND session_key = ?2 AND status = 'running' \
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![target_label, session.key],
                |row| row.get(0),
            )
            .ok();
        if session.has_active_run {
            let run_row = match open {
                Some(id) => id,
                None => {
                    connection.execute(
                        "INSERT INTO session_run (gateway, session_key, agent_id, status, \
                         model, started_at_ms, first_seen_ms, last_seen_ms) \
                         VALUES (?1,?2,?3,'running',?4,?5,?6,?6)",
                        rusqlite::params![
                            target_label,
                            session.key,
                            session.agent_id,
                            session.model,
                            session.started_at.unwrap_or(now),
                            now
                        ],
                    )?;
                    written += 1;
                    connection.last_insert_rowid()
                }
            };
            // 标题/进度：chat.history（admin 会话）。降级路径：FORBIDDEN/超时/断流
            // 都静默跳过——台账行保留，标题留空由前端显示兜底。
            if let Some(client) = client.as_deref_mut() {
                if let Ok(payload) = client.call(
                    "chat.history",
                    // 窗口太短会被人/agent 热闹的长对话淹没 user 消息（2026-10-03
                    // 实测 12 条全只剩 assistant/toolResult），放宽到 50。
                    json!({"sessionKey": session.key, "limit": 50}),
                ) {
                    let title = extract_dispatch_title(&payload);
                    let progress = extract_last_tool_progress(&payload);
                    if title.is_some() || progress.is_some() {
                        let _ = connection.execute(
                            "UPDATE session_run SET title = COALESCE(title, ?2), \
                             progress_summary = COALESCE(?3, progress_summary) WHERE id = ?1",
                            rusqlite::params![run_row, title, progress],
                        );
                    }
                }
            }
            let _ = connection.execute(
                "UPDATE session_run SET last_seen_ms = ?2 WHERE id = ?1",
                rusqlite::params![run_row, now],
            );
        } else if let Some(id) = open {
            // 终态字段指向幻影时，被观察的那个真实 run 的结果网关没单独暴露
            // （2026-10-03 实测 6/6 都是真回复了 OK）：按完成收行，不造失败。
            let (status, error) = if session_run_is_phantom(session) {
                ("done", None)
            } else {
                session_run_terminal_status(session)
            };
            connection.execute(
                "UPDATE session_run SET status = ?2, error = ?3, \
                 ended_at_ms = COALESCE(?4, ?5), last_seen_ms = ?5 \
                 WHERE id = ?1 AND status = 'running'",
                rusqlite::params![id, status, error, session.ended_at, now],
            )?;
            written += 1;
        } else if let Some(ended) = session.ended_at {
            // 漏采补记：短 run 在两拍之间结束，从没被观测为 running。
            if now - ended > options.missed_window_ms {
                continue;
            }
            // announce 幻影（<1s 终态）不是工作，不补记。
            if session_run_is_phantom(session) {
                continue;
            }
            let exists: bool = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_run \
                     WHERE gateway = ?1 AND session_key = ?2 AND COALESCE(ended_at_ms, 0) = ?3",
                    rusqlite::params![target_label, session.key, ended],
                    |row| row.get::<_, i64>(0),
                )
                .map(|count| count > 0)
                .unwrap_or(true);
            if exists {
                continue;
            }
            let (status, error) = session_run_terminal_status(session);
            connection.execute(
                "INSERT INTO session_run (gateway, session_key, agent_id, status, error, \
                 model, started_at_ms, ended_at_ms, first_seen_ms, last_seen_ms) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
                rusqlite::params![
                    target_label,
                    session.key,
                    session.agent_id,
                    status,
                    error,
                    session.model,
                    session.started_at.unwrap_or(ended),
                    ended,
                    now
                ],
            )?;
            written += 1;
        }
    }
    Ok(written)
}

/// chat.history 的 content 可能是纯字符串或分段数组（[{text:...}, ...]）。
fn session_content_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                match item {
                    Value::String(text) => out.push_str(text),
                    Value::Object(part) => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            out.push_str(text);
                        }
                    }
                    _ => {}
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// 派活消息常带 [System: ...] 前缀段（mention 展开说明等），剥掉再当标题。
fn trim_system_prefix(text: &str) -> &str {
    let mut current = text.trim();
    while let Some(rest) = current.strip_prefix("[System:") {
        match rest.find(']') {
            Some(close) => current = rest[close + 1..].trim(),
            None => break,
        }
    }
    current
}

/// 飞书插件把 [System: ...] 说明段整段拼在正文末尾（实测 2026-10-03），剥掉。
/// 只剥"到字符串结尾为止"的完整块——正文中间的 [System: 字样不动。
fn trim_system_suffix(text: &str) -> &str {
    let mut current = text.trim_end();
    while let Some(open) = current.rfind("[System:") {
        let Some(close) = current[open..].find(']') else {
            break;
        };
        if current[open + close + 1..].trim().is_empty() {
            current = current[..open].trim_end();
        } else {
            break;
        }
    }
    current
}

/// 飞书渠道把发送者 id 拼在正文最前（"ou_xxx: 派活原话"），按消息元数据剥掉。
fn strip_sender_prefix<'a>(text: &'a str, message: &Value) -> &'a str {
    let Some(meta) = message.get("__openclaw") else {
        return text;
    };
    for field in ["senderId", "senderName"] {
        let Some(sender) = meta.get(field).and_then(Value::as_str) else {
            continue;
        };
        if sender.is_empty() {
            continue;
        }
        let prefix = format!("{sender}: ");
        if let Some(rest) = text.strip_prefix(prefix.as_str()) {
            return rest;
        }
    }
    text
}

/// 标题 = 最近一条 user 消息的原话（剥发送者前缀与 System 段，截 200 字）。
fn extract_dispatch_title(payload: &Value) -> Option<String> {
    let messages = payload.get("messages")?.as_array()?;
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(raw) = session_content_text(message.get("content")) else {
            continue;
        };
        let text = trim_system_prefix(strip_sender_prefix(&raw, message));
        let text = trim_system_suffix(text);
        if text.is_empty() {
            continue;
        }
        let mut out: String = text.chars().take(200).collect();
        if text.chars().count() > 200 {
            out.push('…');
        }
        return Some(out);
    }
    None
}

/// 进度 = 最近一次工具调用的名字（toolResult / toolCall）。只取名，不取输出。
fn extract_last_tool_progress(payload: &Value) -> Option<String> {
    let messages = payload.get("messages")?.as_array()?;
    for message in messages.iter().rev() {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("toolResult") || role == Some("toolCall") {
            if let Some(name) = message.get("toolName").and_then(Value::as_str) {
                return Some(name.to_owned());
            }
        }
    }
    None
}

/// 会话工作台账的查询行（serde 序列化后直接给前端）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRunRow {
    pub id: i64,
    pub gateway: String,
    pub session_key: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub progress_summary: Option<String>,
    pub model: Option<String>,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

/// 读会话工作台账：按结束/最近活动倒序。前端自行过滤活跃与近期失败。
pub fn list_session_runs(
    connection: &Connection,
    limit: Option<u32>,
) -> Result<Vec<SessionRunRow>> {
    ensure_session_run_table(connection)?;
    let limit = limit.unwrap_or(300).min(2000);
    let sql = format!(
        "SELECT id, gateway, session_key, agent_id, run_id, title, status, error, \
         progress_summary, model, started_at_ms, ended_at_ms, first_seen_ms, last_seen_ms \
         FROM session_run \
         ORDER BY COALESCE(ended_at_ms, last_seen_ms) DESC LIMIT {limit}"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(SessionRunRow {
            id: row.get(0)?,
            gateway: row.get(1)?,
            session_key: row.get(2)?,
            agent_id: row.get(3)?,
            run_id: row.get(4)?,
            title: row.get(5)?,
            status: row.get(6)?,
            error: row.get(7)?,
            progress_summary: row.get(8)?,
            model: row.get(9)?,
            started_at_ms: row.get(10)?,
            ended_at_ms: row.get(11)?,
            first_seen_ms: row.get(12)?,
            last_seen_ms: row.get(13)?,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT_LEDGER: SessionLedgerOptions = SessionLedgerOptions {
        retention_ms: SESSION_RUN_RETENTION_MS,
        missed_window_ms: SESSION_RUN_MISSED_WINDOW_MS,
    };

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        ensure_session_run_table(&connection).unwrap();
        connection
    }

    fn task(id: &str, status: &str, ended: Option<i64>) -> GatewayTask {
        GatewayTask {
            task_id: Some(id.to_owned()),
            status: Some(status.to_owned()),
            ended_at: ended,
            title: Some(format!("task {id}")),
            runtime: Some("subagent".to_owned()),
            ..Default::default()
        }
    }

    fn snapshot_at(ms: i64, tasks: Vec<GatewayTask>) -> TasksSnapshot {
        TasksSnapshot {
            collected_at_ms: ms,
            tasks,
        }
    }

    #[test]
    fn upsert_creates_then_updates_without_regressing_terminal() {
        let db = memory_db();
        // 首见：running
        assert_eq!(
            upsert_tasks(
                &db,
                "本机",
                &snapshot_at(100, vec![task("t1", "running", None)])
            )
            .unwrap(),
            1
        );
        // 终态到达：completed → succeeded
        assert_eq!(
            upsert_tasks(
                &db,
                "本机",
                &snapshot_at(200, vec![task("t1", "succeeded", Some(150))])
            )
            .unwrap(),
            1
        );
        // 乱序：旧的 running 快照后到，不得回退终态
        assert_eq!(
            upsert_tasks(
                &db,
                "本机",
                &snapshot_at(300, vec![task("t1", "running", None)])
            )
            .unwrap(),
            0,
            "终态行不得被 running 快照回退"
        );
        let stored: (String, Option<i64>) = db
            .query_row(
                "SELECT status, ended_at_ms FROM gateway_task WHERE task_id='t1' AND gateway='本机'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "succeeded");
        assert_eq!(stored.1, Some(150));
    }

    #[test]
    fn progress_summary_round_trips_through_ledger() {
        let db = memory_db();
        let mut running = task("t1", "running", None);
        running.progress_summary = Some("已检索 12 篇研报".to_owned());
        upsert_tasks(&db, "本机", &snapshot_at(100, vec![running])).unwrap();
        // 下一拍进度刷新：新话覆盖旧话；快照没带进度时保留旧话。
        let mut advanced = task("t1", "running", None);
        advanced.progress_summary = Some("正在对比装机成本".to_owned());
        upsert_tasks(&db, "本机", &snapshot_at(200, vec![advanced])).unwrap();
        upsert_tasks(
            &db,
            "本机",
            &snapshot_at(300, vec![task("t1", "running", None)]),
        )
        .unwrap();
        let rows = list_tasks(&db, None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].progress_summary.as_deref(),
            Some("正在对比装机成本")
        );
    }

    #[test]
    fn same_task_id_on_two_gateways_stays_separate() {
        let db = memory_db();
        upsert_tasks(
            &db,
            "本机",
            &snapshot_at(100, vec![task("t1", "running", None)]),
        )
        .unwrap();
        upsert_tasks(
            &db,
            "VPS",
            &snapshot_at(100, vec![task("t1", "failed", Some(120))]),
        )
        .unwrap();
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM gateway_task", [], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 2, "同名任务在不同网关是两条记录");
    }

    #[test]
    fn tasks_without_id_are_skipped() {
        let db = memory_db();
        let mut bad = task("", "running", None);
        bad.task_id = None;
        assert_eq!(
            upsert_tasks(&db, "本机", &snapshot_at(1, vec![bad])).unwrap(),
            0
        );
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM gateway_task", [], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn device_identity_round_trip_and_signature_verifies() {
        let dir = std::env::temp_dir().join(format!("metrik-gw-ident-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_create_identity(&dir).unwrap();
        let second = load_or_create_identity(&dir).unwrap();
        assert_eq!(first.device_id, second.device_id, "身份必须稳定复用");
        // OpenClaw deviceId 形态：sha256(rawPubKey).hex（64 字符）。
        assert_eq!(first.device_id.len(), 64, "sha256 hex deviceId = 64 chars");

        // 一致性：device_id 必须等于 sha256(提取公钥).hex（OpenClaw 公式）
        let public_raw = ed25519_public_from_pkcs8(&first.private_key_der).unwrap();
        assert_eq!(sha256_hex(&public_raw), first.device_id);
        // 密码学自证：从存储的 DER 重建 keypair 签名，用提取出的公钥验签——
        // 提取错了（比如拿到私钥）这一步必然失败。
        let pair =
            ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&first.private_key_der)
                .unwrap();
        let sig = pair.sign(b"payload");
        assert_eq!(sig.as_ref().len(), 64);
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public_raw)
            .verify(b"payload", sig.as_ref())
            .expect("extracted public key must verify the signature");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64url_round_trip() {
        for len in [0usize, 1, 2, 3, 4, 31, 32, 33, 64] {
            let data: Vec<u8> = (0..len as u8).collect();
            let encoded = base64url(&data);
            assert!(!encoded.contains('='), "url-safe 无 padding");
            assert_eq!(base64_decode(&encoded).unwrap(), data, "len {len}");
        }
        // deviceId 形态：Ed25519 公钥 32 字节 → 恰好 43 字符。
        let pk = [7u8; 32];
        assert_eq!(base64url(&pk).len(), 43);
    }

    fn session_run_fixture(
        key: &str,
        active: bool,
        status: Option<&str>,
        started: Option<i64>,
        ended: Option<i64>,
        error: Option<&str>,
    ) -> SessionUsage {
        SessionUsage {
            key: key.to_owned(),
            gateway: "vps".to_owned(),
            agent_id: Some(key.split(':').nth(1).unwrap_or("agent").to_owned()),
            has_active_run: active,
            status: status.map(str::to_owned),
            started_at: started,
            ended_at: ended,
            last_run_error: error.map(str::to_owned),
            ..Default::default()
        }
    }

    #[test]
    fn session_run_records_open_then_close_with_terminal_protection() {
        let connection = memory_db();
        let now = chrono::Utc::now().timestamp_millis();
        let started = now - 60_000;
        let key = "agent:tianshu:feishu:group:oc_1";
        // 第一拍：天枢群会话在跑 → 记一行 running
        let running = vec![session_run_fixture(
            key,
            true,
            Some("running"),
            Some(started),
            None,
            None,
        )];
        assert_eq!(
            record_session_runs(&connection, "vps", &running, None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        let runs = list_session_runs(&connection, None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status.as_deref(), Some("running"));
        assert_eq!(runs[0].started_at_ms, Some(started));
        // 第二拍：还在跑 → 不新增
        assert_eq!(
            record_session_runs(&connection, "vps", &running, None, &DEFAULT_LEDGER).unwrap(),
            0
        );
        assert_eq!(list_session_runs(&connection, None).unwrap().len(), 1);
        // 第三拍：结束且 failed → 落终态带错误原话；再拍不回写
        let closed = vec![session_run_fixture(
            key,
            false,
            Some("failed"),
            Some(started),
            Some(now - 30_000),
            Some("provider 502"),
        )];
        assert_eq!(
            record_session_runs(&connection, "vps", &closed, None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        let runs = list_session_runs(&connection, None).unwrap();
        assert_eq!(runs[0].status.as_deref(), Some("failed"));
        assert_eq!(runs[0].error.as_deref(), Some("provider 502"));
        assert_eq!(runs[0].ended_at_ms, Some(now - 30_000));
        assert_eq!(
            record_session_runs(&connection, "vps", &closed, None, &DEFAULT_LEDGER).unwrap(),
            0
        );
    }

    #[test]
    fn session_run_backfills_missed_short_runs_once() {
        let connection = memory_db();
        let now = chrono::Utc::now().timestamp_millis();
        // 短 run 在两拍之间开始并结束：hasActiveRun=false + ended 在漏采窗口内
        let missed = vec![session_run_fixture(
            "agent:tianxuan:feishu:group:oc_1",
            false,
            Some("done"),
            Some(now - 90_000),
            Some(now - 20_000),
            None,
        )];
        assert_eq!(
            record_session_runs(&connection, "vps", &missed, None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        // 同一结束时间戳重复观测 → 不重复补
        assert_eq!(
            record_session_runs(&connection, "vps", &missed, None, &DEFAULT_LEDGER).unwrap(),
            0
        );
        assert_eq!(list_session_runs(&connection, None).unwrap().len(), 1);
        // 漏采窗口外（>1h）的老终态不补
        let old = vec![session_run_fixture(
            "agent:tianji:main",
            false,
            Some("done"),
            Some(now - 3 * 3_600_000),
            Some(now - 2 * 3_600_000),
            None,
        )];
        assert_eq!(
            record_session_runs(&connection, "vps", &old, None, &DEFAULT_LEDGER).unwrap(),
            0
        );
    }

    #[test]
    fn session_run_ignores_phantom_announce_runs() {
        let connection = memory_db();
        let now = chrono::Utc::now().timestamp_millis();
        let superseded = "prepared model runtime plugin generation was superseded";
        // 12ms 即终态的幻影（sessions_send announce 唤醒即被取代）→ 不入账
        let mut phantom = session_run_fixture(
            "agent:kaiyang:feishu:group:oc_1",
            false,
            Some("failed"),
            Some(now - 5_000),
            Some(now - 4_000),
            Some(superseded),
        );
        phantom.runtime_ms = Some(12);
        assert_eq!(
            record_session_runs(&connection, "vps", &[phantom], None, &DEFAULT_LEDGER).unwrap(),
            0
        );
        assert_eq!(list_session_runs(&connection, None).unwrap().len(), 0);
        // 真实短失败（5s，模型真跑过）照常补记
        let mut real = session_run_fixture(
            "agent:tianji:feishu:group:oc_1",
            false,
            Some("failed"),
            Some(now - 9_000),
            Some(now - 4_000),
            Some("provider 502"),
        );
        real.runtime_ms = Some(5_000);
        assert_eq!(
            record_session_runs(&connection, "vps", &[real], None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        assert_eq!(list_session_runs(&connection, None).unwrap().len(), 1);
    }

    #[test]
    fn session_run_closes_observed_row_when_fields_point_at_phantom() {
        let connection = memory_db();
        let now = chrono::Utc::now().timestamp_millis();
        let key = "agent:yaoguang:feishu:group:oc_1";
        let running = vec![session_run_fixture(
            key,
            true,
            Some("running"),
            Some(now - 60_000),
            None,
            None,
        )];
        assert_eq!(
            record_session_runs(&connection, "vps", &running, None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        // 终态字段指向 12ms 幻影：真实 run 结果未单独暴露，按完成收行、不造失败
        let superseded = "prepared model runtime plugin generation was superseded";
        let mut phantom = session_run_fixture(
            key,
            false,
            Some("failed"),
            Some(now - 60_000),
            Some(now - 2_000),
            Some(superseded),
        );
        phantom.runtime_ms = Some(12);
        assert_eq!(
            record_session_runs(&connection, "vps", &[phantom], None, &DEFAULT_LEDGER).unwrap(),
            1
        );
        let runs = list_session_runs(&connection, None).unwrap();
        assert_eq!(runs[0].status.as_deref(), Some("done"));
        assert_eq!(runs[0].error.as_deref(), None);
    }

    #[test]
    fn dispatch_title_strips_sender_id_and_system_blocks() {
        // 真机实测形态：发送者 open_id 前缀 + 尾部两段 [System: ...] 说明
        let payload = json!({"messages": [
            {"role": "assistant", "content": "OK"},
            {"role": "user", "content": concat!(
                "ou_a31eeb382624e5bd502bc339e01c1a36: 重新执行一个最省token的任务\n\n",
                "[System: mention tags may appear as <at user_id=\"...\">name</at>.]",
                "[System: If user_id is \"ou_2a92\", that mention refers to you.]"
            ),
             "__openclaw": {"senderId": "ou_a31eeb382624e5bd502bc339e01c1a36"}},
        ]});
        assert_eq!(
            extract_dispatch_title(&payload).as_deref(),
            Some("重新执行一个最省token的任务")
        );
        // 无发送者元数据：头部 [System:] 照旧剥，尾部块也剥
        let plain = json!({"messages": [
            {"role": "user", "content": "[System: intro] 帮我跑一遍\n\n[System: tail]"}
        ]});
        assert_eq!(
            extract_dispatch_title(&plain).as_deref(),
            Some("帮我跑一遍")
        );
        // content 缺失的 user 消息跳过、继续往早找，不整单放弃
        let hole = json!({"messages": [
            {"role": "user", "content": null},
            {"role": "user", "content": "较早的派活原话"}
        ]});
        assert_eq!(
            extract_dispatch_title(&hole).as_deref(),
            Some("较早的派活原话")
        );
    }

    #[test]
    fn session_run_retention_deletes_after_seven_days() {
        let connection = memory_db();
        let now = chrono::Utc::now().timestamp_millis();
        let stale_ms = now - 8 * 24 * 3_600_000;
        // 漏采窗口外的老终态不会自动入账；手工插一条 8 天前的旧账验证清理
        connection
            .execute(
                "INSERT INTO session_run (gateway, session_key, status, first_seen_ms, last_seen_ms) \
                 VALUES ('vps','agent:tianshu:main','done',?1,?1)",
                rusqlite::params![stale_ms],
            )
            .unwrap();
        let fresh = vec![session_run_fixture(
            "agent:tianshu:feishu:group:oc_2",
            true,
            Some("running"),
            Some(now),
            None,
            None,
        )];
        record_session_runs(&connection, "vps", &fresh, None, &DEFAULT_LEDGER).unwrap();
        let runs = list_session_runs(&connection, None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status.as_deref(), Some("running"));
    }
}
