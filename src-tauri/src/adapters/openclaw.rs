//! OpenClaw（openclaw/openclaw 及其发行版）本地用量适配器。
//!
//! 数据源：`<state_dir 或 profile>/agents/*/sessions/<sessionId>.jsonl` 会话转录。
//! 每行一个 JSON 事件；`type == "message"` 且 `message.role == "assistant"`、
//! `message.usage` 非空的记录是一次模型调用的**最终**用量（同一条消息不会以
//! 渐进更新的形态重复出现；本机 113 条 usage 消息 id 全部唯一）。
//!
//! 计量口径（2026-09-15 按本机 AutoClaw 数据核实；会话转录是上游核心格式，
//! 与原版 openclaw 同构，字段语义应一致——接 VPS 数据时先抽样复核）：
//! - `usage.input` 是**未缓存输入**：`totalTokens == input + cacheRead + output`
//!   对全部抽样严格成立（39668+144832+4522=189022 等），与账本
//!   `input_uncached_tokens` 同口径，原样入账；
//! - `usage.cacheWrite` 实测恒为 0 且字段可缺位：缺位按 0 计（缺字段不是错，
//!   不从别的量反推）；
//! - `usage.reasoningTokens ⊆ output`（思考是输出的子项），只作展示明细，
//!   不重复计入 processed；
//! - `usage.cost` 是来源自报的成本参考，不采信——成本是账本自己的估算事实。
//!
//! 身份与合并：事件键 = `openclaw:{sessionId}:{messageId}`。`/fork` 与分支
//! 会把整条转录逐字复制进新会话文件，复制体带新 sessionId 但同 messageId，
//! 与 pi /fork 同型——账本层按 `openclaw:` 前缀识别做分量最大值合并
//! （见 storage），相同观察是 no-op，矛盾才可见。
//!
//! 归属：session 头事件（`type == "session"`）带 `cwd`，是事件真实发生的
//! 工作目录；读不到就 None，不从路径反推。同一文件内 cwd 以最近一次
//! session 头为准（转录按时间追加，resume 可能换目录）。
//!
//! 模型：`message.model`（provider + modelId 的组合由 model_change 事件与
//! 消息内 model 字段共同决定，以消息内字段为准）。

use super::{discover_jsonl, AgentAdapter, ParsedScan, ScanDiagnostics, SourceCandidate};
use crate::domain::{ParsedSource, TokenVector, UsageEvent};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub struct OpenclawAdapter {
    roots: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct TranscriptLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    message: Option<TranscriptMessage>,
}

#[derive(Deserialize)]
struct TranscriptMessage {
    role: Option<String>,
    model: Option<String>,
    usage: Option<TranscriptUsage>,
}

/// 计量字段按本机真实转录核实为 camelCase（cacheRead / cacheWrite /
/// reasoningTokens / totalTokens）；不做无据兼容。
#[derive(Deserialize)]
struct TranscriptUsage {
    #[serde(default)]
    input: Option<i64>,
    #[serde(default)]
    output: Option<i64>,
    #[serde(default, rename = "cacheRead")]
    cache_read: Option<i64>,
    #[serde(default, rename = "cacheWrite")]
    cache_write: Option<i64>,
    #[serde(default, rename = "reasoningTokens")]
    reasoning_tokens: Option<i64>,
    #[serde(default, rename = "totalTokens")]
    total_tokens: Option<i64>,
}

impl TranscriptUsage {
    fn cache_read_value(&self) -> i64 {
        self.cache_read.unwrap_or(0).max(0)
    }
    fn cache_write_value(&self) -> i64 {
        self.cache_write.unwrap_or(0).max(0)
    }
    fn reasoning_value(&self) -> i64 {
        self.reasoning_tokens.unwrap_or(0).max(0)
    }
}

impl OpenclawAdapter {
    pub fn detected() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        // AutoClaw 发行版（Windows 默认）与原版 ~/.openclaw 都扫：两个根都
        // 不存在时 discover 自然返回空。OPENCLAW_STATE_DIR 与 openclaw.json
        // 同级，供自定义安装覆盖。
        let mut roots = vec![home.join(".openclaw")];
        if let Some(state_dir) = std::env::var_os("OPENCLAW_STATE_DIR")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        {
            roots.push(state_dir);
        }
        roots.push(home.join(".openclaw-autoclaw"));
        roots.retain(|root| root.is_dir());
        Self { roots }
    }

    #[cfg(test)]
    fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self { roots }
    }
}

impl AgentAdapter for OpenclawAdapter {
    fn id(&self) -> &'static str {
        "openclaw"
    }

    fn discover(&self, cutoff_ms: i64) -> Vec<SourceCandidate> {
        // 只收会话转录 <sessionId>.jsonl，排除 .trajectory.jsonl（运行时
        // trace 文件，目录里两者共存）。
        discover_jsonl(&self.roots, self.id(), cutoff_ms)
            .into_iter()
            .filter(|candidate| {
                candidate
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| !name.ends_with(".trajectory.jsonl"))
            })
            .collect()
    }

    fn parse(&self, candidate: &SourceCandidate, cutoff_ms: i64) -> Result<ParsedScan> {
        let file = File::open(&candidate.path)
            .with_context(|| format!("failed to open {}", candidate.path.display()))?;
        let reader = BufReader::with_capacity(256 * 1024, file);

        // 会话 id 取 session 头事件；转录文件名也是 <sessionId>.jsonl，
        // 头事件缺失时回退文件名（路径不是计量事实，只是标识兜底）。
        let fallback_session = candidate
            .path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown-session")
            .to_owned();
        let session_id = fallback_session.clone();
        let mut project_path: Option<String> = None;

        let mut diagnostics = ScanDiagnostics::default();
        let track_skipped_lines = candidate.mtime_ns / 1_000_000 >= cutoff_ms;
        let mut events: Vec<UsageEvent> = Vec::new();

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => {
                    if track_skipped_lines {
                        diagnostics.unreadable_lines += 1;
                    }
                    continue;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<TranscriptLine>(&line) else {
                if track_skipped_lines {
                    diagnostics.malformed_lines += 1;
                }
                continue;
            };
            match record.kind.as_deref() {
                Some("session") => {
                    if let Some(cwd) = record.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
                        project_path = Some(cwd.to_owned());
                    }
                    continue;
                }
                Some("message") => {}
                _ => continue,
            }
            let Some(message) = record.message else {
                continue;
            };
            if message.role.as_deref() != Some("assistant") {
                continue;
            }
            let Some(usage) = message.usage else {
                continue;
            };
            let message_id = match record.id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => id,
                None => {
                    if track_skipped_lines {
                        diagnostics.rejected_events += 1;
                    }
                    continue;
                }
            };
            let Some(occurred_at_ms) = super::timestamp_str_ms(record.timestamp.as_deref()) else {
                if track_skipped_lines {
                    diagnostics.rejected_events += 1;
                }
                continue;
            };
            if occurred_at_ms < cutoff_ms {
                continue;
            }

            // input 已是未缓存口径（total = input + cacheRead + output，
            // 实测全部成立）；cacheWrite 缺位按 0；reasoning ⊆ output。
            let cache_read = usage.cache_read_value();
            let cache_write = usage.cache_write_value();
            let input_reported = usage.input.unwrap_or(0).max(0);
            let output = usage.output.unwrap_or(0).max(0);
            let tokens = TokenVector {
                input_uncached: input_reported,
                cache_read,
                cache_write,
                output,
                reasoning_output: usage.reasoning_value().min(output),
            };
            if tokens.disagrees_with_reported_total(usage.total_tokens.unwrap_or(0)) {
                diagnostics.total_mismatches += 1;
            }
            if tokens.processed() <= 0 {
                continue;
            }

            let event = UsageEvent::new(
                self.id(),
                format!("openclaw:{session_id}:{message_id}"),
                occurred_at_ms,
                session_id.clone(),
                message.model.clone().filter(|model| !model.is_empty()),
                tokens,
                "message_usage",
            )
            .with_project(project_path.clone());
            events.push(event);
        }

        events.sort_by_key(|event| event.occurred_at_ms);
        Ok(ParsedScan {
            source: ParsedSource {
                source_id: candidate.source_id.clone(),
                adapter_id: self.id(),
                locator: candidate.path.clone(),
                logical_key: session_id,
                size: candidate.size,
                mtime_ns: candidate.mtime_ns,
                events,
                quotas: Vec::new(),
            },
            diagnostics,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, body: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("metrik-openclaw-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aaaaaaaa-1111-2222-3333-444444444444.jsonl");
        let mut file = File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        path
    }

    fn parse_file(path: &Path) -> ParsedScan {
        let meta = path.metadata().unwrap();
        let candidate = SourceCandidate {
            source_id: "s".into(),
            path: path.clone(),
            size: meta.len(),
            mtime_ns: 1,
        };
        OpenclawAdapter::with_roots(vec![])
            .parse(&candidate, i64::MIN)
            .unwrap()
    }

    /// 口径主用例：input 未缓存、cacheRead 独立分量、reasoning ⊆ output、
    /// total 自检通过。
    #[test]
    fn assistant_usage_splits_components_and_self_checks() {
        let body = concat!(
            r#"{"type":"session","version":1,"id":"aaaaaaaa-1111-2222-3333-444444444444","timestamp":"2026-09-15T09:00:00.000Z","cwd":"C:\\work\\demo"}"#,
            "\n",
            r#"{"type":"message","id":"m1","timestamp":"2026-09-15T09:09:01.508Z","message":{"role":"assistant","provider":"zai","model":"zai_glm-5.3-flash","usage":{"input":39668,"output":4522,"cacheRead":144832,"reasoningTokens":3330,"totalTokens":189022}}}"#,
            "\n",
            r#"{"type":"message","id":"m2","timestamp":"2026-09-15T09:10:01.000Z","message":{"role":"user"}}"#,
            "\n",
            r#"{"type":"message","id":"m3","timestamp":"2026-09-15T09:11:01.000Z","message":{"role":"assistant","model":"zai_glm-5.3-flash","usage":{"input":100,"output":30,"cacheRead":0,"cacheWrite":0,"reasoningTokens":10,"totalTokens":130}}}"#,
            "\n"
        );
        let path = write_temp("usage", body);
        let parsed = parse_file(&path);
        assert_eq!(parsed.source.events.len(), 2);
        assert_eq!(parsed.diagnostics.total_mismatches, 0);
        let first = &parsed.source.events[0];
        assert_eq!(first.tokens.input_uncached, 39668);
        assert_eq!(first.tokens.cache_read, 144832);
        assert_eq!(first.tokens.cache_write, 0);
        assert_eq!(first.tokens.output, 4522);
        assert_eq!(first.tokens.reasoning_output, 3330);
        // processed = input + cacheRead + output；reasoning 不另加
        assert_eq!(first.tokens.processed(), 189_022);
        assert_eq!(first.model.as_deref(), Some("zai_glm-5.3-flash"));
        assert_eq!(
            first.project_path.as_deref(),
            Some("C:/work/demo"),
            "cwd 反斜杠归一化为正斜杠"
        );
        assert!(first.event_key.starts_with("openclaw:aaaaaaaa-1111"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 口径自检失败必须可见：分量和与来源自报总量对不上 → 数据不完整。
    #[test]
    fn reported_total_mismatch_is_flagged() {
        let body = concat!(
            r#"{"type":"message","id":"m1","timestamp":"2026-09-15T09:09:01.508Z","message":{"role":"assistant","usage":{"input":100,"output":20,"cacheRead":0,"totalTokens":999}}}"#,
            "\n"
        );
        let path = write_temp("mismatch", body);
        let parsed = parse_file(&path);
        assert_eq!(parsed.diagnostics.total_mismatches, 1);
        assert!(parsed.diagnostics.is_partial());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 缺 totalTokens 不是错（来源没报就不判定）；缺 usage 的消息跳过；
    /// 空总量不误报。
    #[test]
    fn missing_total_and_missing_usage_are_tolerated() {
        let body = concat!(
            r#"{"type":"message","id":"m1","timestamp":"2026-09-15T09:09:01.508Z","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":0}}}"#,
            "\n",
            r#"{"type":"message","id":"m2","timestamp":"2026-09-15T09:09:02.000Z","message":{"role":"assistant"}}"#,
            "\n"
        );
        let path = write_temp("no-total", body);
        let parsed = parse_file(&path);
        assert_eq!(parsed.source.events.len(), 1);
        assert_eq!(parsed.diagnostics.total_mismatches, 0);
        assert_eq!(parsed.diagnostics.malformed_lines, 0);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 同文件内 resume 换目录：事件按最近的 session 头归属（时间顺序）。
    #[test]
    fn cwd_follows_latest_session_header() {
        let body = concat!(
            r#"{"type":"session","id":"aaaaaaaa-1111-2222-3333-444444444444","timestamp":"2026-09-15T09:00:00.000Z","cwd":"C:\\work\\a"}"#,
            "\n",
            r#"{"type":"message","id":"m1","timestamp":"2026-09-15T09:09:01.508Z","message":{"role":"assistant","usage":{"input":10,"output":1,"cacheRead":0,"totalTokens":11}}}"#,
            "\n",
            r#"{"type":"session","id":"aaaaaaaa-1111-2222-3333-444444444444","timestamp":"2026-09-15T10:00:00.000Z","cwd":"C:\\work\\b"}"#,
            "\n",
            r#"{"type":"message","id":"m2","timestamp":"2026-09-15T10:09:01.508Z","message":{"role":"assistant","usage":{"input":20,"output":2,"cacheRead":0,"totalTokens":22}}}"#,
            "\n"
        );
        let path = write_temp("cwd", body);
        let parsed = parse_file(&path);
        let projects: Vec<Option<&str>> = parsed
            .source
            .events
            .iter()
            .map(|event| event.project_path.as_deref())
            .collect();
        assert_eq!(projects, vec![Some("C:/work/a"), Some("C:/work/b")]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 损坏行计数为 partial，但不清空同文件的其他有效事件。
    #[test]
    fn malformed_lines_mark_partial_without_dropping_events() {
        let body = concat!(
            "{not json}\n",
            r#"{"type":"message","id":"m1","timestamp":"2026-09-15T09:09:01.508Z","message":{"role":"assistant","usage":{"input":10,"output":1,"cacheRead":0,"totalTokens":11}}}"#,
            "\n"
        );
        let path = write_temp("malformed", body);
        let parsed = parse_file(&path);
        assert_eq!(parsed.source.events.len(), 1);
        assert_eq!(parsed.diagnostics.malformed_lines, 1);
        assert!(parsed.diagnostics.is_partial());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// discover 排除 .trajectory.jsonl：同一目录两类文件共存，只收转录。
    #[test]
    fn discover_skips_trajectory_files() {
        let dir = std::env::temp_dir().join(format!("metrik-openclaw-disc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("main").join("sessions")).unwrap();
        std::fs::write(
            dir.join("main").join("sessions").join("s1.jsonl"),
            "{\"type\":\"session\"}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("main")
                .join("sessions")
                .join("s1.trajectory.jsonl"),
            "{\"traceSchema\":\"openclaw-trajectory\"}\n",
        )
        .unwrap();
        let adapter = OpenclawAdapter::with_roots(vec![dir.clone()]);
        let found = adapter.discover(0);
        assert_eq!(found.len(), 1, "只应发现转录文件");
        assert!(found[0].path.ends_with("s1.jsonl"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 时间裁剪：早于 cutoff 的事件不入账（增量扫描协议）。
    #[test]
    fn events_before_cutoff_are_skipped() {
        let body = concat!(
            r#"{"type":"message","id":"m1","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"assistant","usage":{"input":10,"output":1,"cacheRead":0,"totalTokens":11}}}"#,
            "\n"
        );
        let path = write_temp("cutoff", body);
        let meta = path.metadata().unwrap();
        let candidate = SourceCandidate {
            source_id: "s".into(),
            path: path.clone(),
            size: meta.len(),
            mtime_ns: 1,
        };
        let parsed = OpenclawAdapter::with_roots(vec![])
            .parse(&candidate, i64::MAX / 2)
            .unwrap();
        assert_eq!(parsed.source.events.len(), 0);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
