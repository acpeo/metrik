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
//! - 无 tasks.flow RPC；TaskFlow 编排状态不在本连接器范围（CLI 专用）。
//!
//! 隐私边界：账本只存任务元数据（id / 标题 / 状态 / 时间 / 会话键），
//! 不存 prompt、回复正文、工具输出与凭据；token 与设备私钥只在内存使用。

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
    digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn base64url(data: &[u8]) -> String {
    // URL-safe 且无 padding：OpenClaw 的 deviceId 是 Ed25519 公钥
    // （32 字节）的 43 字符 base64url，不带 '='。与本机实测配对记录一致。
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
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
                let spki_der = pem_to_der(spki_pem)
                    .context("device.json publicKeyPem is not valid PEM")?;
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
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&identity.private_key_der)
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
        let scopes = ["operator.read"];
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
        let ok = hello
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
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

        Ok(Self {
            socket,
            next_id: 1,
        })
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
                    let value: Value = serde_json::from_str(&text)
                        .context("non-JSON gateway frame")?;
                    if value.get("type").and_then(Value::as_str) == Some("event")
                        && value.get("event").and_then(Value::as_str)
                            == Some("connect.challenge")
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

    fn send(socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, value: &Value) -> Result<()> {
        socket
            .send(Message::text(serde_json::to_string(value)?))
            .map_err(|error| anyhow!("gateway send failed: {error}"))
    }

    fn wait_response(
        socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
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
    #[serde(default)]
    pub label: Option<String>,
}

/// 一次拉取的结果：全部快照任务 + 观测时间。
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

/// 每次快照把观察到的任务 upsert 进本地账本：
/// - 运行中任务更新时间戳；终态任务落最终状态后不再被旧快照覆盖（观察合并
///   取"更完整"的记录：ended_at 补齐即视为更完整）。
/// - 不删除任何记录：任务历史永久保留（这是本表存在的意义）。
pub fn upsert_tasks(connection: &Connection, target_label: &str, snapshot: &TasksSnapshot) -> Result<usize> {
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
            first_seen_ms  INTEGER NOT NULL,
            last_seen_ms   INTEGER NOT NULL,
            PRIMARY KEY (task_id, gateway)
        );
        CREATE INDEX IF NOT EXISTS idx_gateway_task_gateway_time
            ON gateway_task(gateway, first_seen_ms);",
    )?;
    let mut written = 0usize;
    for task in &snapshot.tasks {
        let task_id = match task.task_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => id,
            None => continue,
        };
        let status = task.status.as_deref();
        let has_terminal = matches!(
            status,
            Some("succeeded") | Some("failed") | Some("timed_out") | Some("cancelled") | Some("lost")
        );
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
            let stored_is_terminal = matches!(
                stored_status.as_str(),
                "succeeded" | "failed" | "timed_out" | "cancelled" | "lost"
            );
            if stored_is_terminal && !has_terminal {
                continue;
            }
        }
        connection.execute(
            "INSERT INTO gateway_task (
                task_id, gateway, runtime, kind, status, title, label, agent_id,
                session_key, child_session_key, run_id,
                created_at_ms, started_at_ms, ended_at_ms, updated_at_ms,
                terminal_summary, error, first_seen_ms, last_seen_ms
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
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
         ended_at_ms, updated_at_ms, terminal_summary, error, first_seen_ms, last_seen_ms \
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
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        Connection::open_in_memory().unwrap()
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
        TasksSnapshot { collected_at_ms: ms, tasks }
    }

    #[test]
    fn upsert_creates_then_updates_without_regressing_terminal() {
        let db = memory_db();
        // 首见：running
        assert_eq!(
            upsert_tasks(&db, "本机", &snapshot_at(100, vec![task("t1", "running", None)]))
                .unwrap(),
            1
        );
        // 终态到达：completed → succeeded
        assert_eq!(
            upsert_tasks(&db, "本机", &snapshot_at(200, vec![task("t1", "succeeded", Some(150))]))
                .unwrap(),
            1
        );
        // 乱序：旧的 running 快照后到，不得回退终态
        assert_eq!(
            upsert_tasks(&db, "本机", &snapshot_at(300, vec![task("t1", "running", None)]))
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
    fn same_task_id_on_two_gateways_stays_separate() {
        let db = memory_db();
        upsert_tasks(&db, "本机", &snapshot_at(100, vec![task("t1", "running", None)])).unwrap();
        upsert_tasks(&db, "VPS", &snapshot_at(100, vec![task("t1", "failed", Some(120))])).unwrap();
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
        assert_eq!(upsert_tasks(&db, "本机", &snapshot_at(1, vec![bad])).unwrap(), 0);
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
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&first.private_key_der)
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
}
