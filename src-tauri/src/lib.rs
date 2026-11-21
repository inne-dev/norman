use std::{
    collections::{HashMap, HashSet},
    env, fs::{self, File},
    io::{Cursor, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ego_tree::NodeRef;
use encoding_rs::{Encoding, UTF_8};
use regex::{Regex, RegexBuilder};
use scraper::{Html, Node, Selector};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use thiserror::Error;
use url::Url;

mod codex;
mod norman;
mod ollama_setup;
mod process;

const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 15 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_URL_BYTES: usize = 4 * 1024 * 1024;
const MAX_URL_REDIRECTS: usize = 5;
const MAX_FINDINGS: usize = 500;
const MAX_FINDINGS_PER_RULE: usize = 40;
const MAX_PARALLEL_PROCESSES: usize = 4;
const MAX_ANALYSIS_ID_BYTES: usize = 256;
const MAX_REPORT_PDF_BYTES: usize = 64 * 1024 * 1024;
const RULES_JSON: &str = include_str!("../../data/rules.json");

pub(crate) fn normalize_parallel_processes(value: Option<serde_json::Value>) -> usize {
    value
        .and_then(|value| value.as_u64())
        .filter(|count| (1..=MAX_PARALLEL_PROCESSES as u64).contains(count))
        .map(|count| count as usize)
        .unwrap_or(1)
}

#[derive(Default)]
pub(crate) struct AnalysisPauseRegistry {
    controls: Mutex<HashMap<String, Arc<AnalysisPauseControl>>>,
}

#[derive(Default)]
struct PauseState {
    requested: bool,
    cancelled: bool,
}

#[derive(Default)]
pub(crate) struct AnalysisPauseControl {
    state: Mutex<PauseState>,
    changed: Condvar,
    active_process_groups: Mutex<HashSet<u32>>,
}

impl AnalysisPauseRegistry {
    pub(crate) fn control(&self, analysis_id: &str) -> Arc<AnalysisPauseControl> {
        let mut controls = self.controls.lock().unwrap_or_else(|error| error.into_inner());
        controls
            .entry(analysis_id.to_string())
            .or_default()
            .clone()
    }

    fn release(&self, analysis_id: &str) {
        if let Some(control) = self
            .controls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(analysis_id)
        {
            control.set_paused(false);
        }
    }

    fn cancel_all(&self) {
        let controls = self
            .controls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for control in controls {
            control.cancel();
        }
    }
}

pub(crate) fn analysis_pause_control(
    app: &tauri::AppHandle,
    analysis_id: &str,
) -> Result<Arc<AnalysisPauseControl>, String> {
    if analysis_id.trim().is_empty() || analysis_id.len() > MAX_ANALYSIS_ID_BYTES {
        return Err("Не удалось определить запуск анализа.".into());
    }
    Ok(app.state::<AnalysisPauseRegistry>().control(analysis_id))
}

impl AnalysisPauseControl {
    fn set_paused(&self, paused: bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.requested = paused;
        if !paused {
            self.changed.notify_all();
        }
    }

    pub(crate) fn checkpoint(&self, app: &tauri::AppHandle, analysis_id: &str) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.requested || state.cancelled {
            return;
        }
        drop(state);
        let _ = app.emit(
            "analysis-pause-state",
            serde_json::json!({ "analysisId": analysis_id, "paused": true }),
        );

        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.requested && !state.cancelled {
            state = self.changed.wait(state).unwrap_or_else(|error| error.into_inner());
        }
        drop(state);
        let _ = app.emit(
            "analysis-pause-state",
            serde_json::json!({ "analysisId": analysis_id, "paused": false }),
        );
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.state.lock().unwrap_or_else(|error| error.into_inner()).cancelled
    }

    pub(crate) fn register_process_group(&self, process_id: u32) {
        let mut process_groups = self
            .active_process_groups
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.is_cancelled() {
            terminate_ai_process_group(process_id);
        } else {
            process_groups.insert(process_id);
        }
    }

    pub(crate) fn unregister_process_group(&self, process_id: u32) {
        self.active_process_groups
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&process_id);
    }

    fn cancel(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.cancelled = true;
        state.requested = false;
        self.changed.notify_all();
        drop(state);

        let process_groups = self
            .active_process_groups
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .copied()
            .collect::<Vec<_>>();
        for process_id in process_groups {
            terminate_ai_process_group(process_id);
        }
    }
}

pub(crate) fn terminate_ai_process_group(process_id: u32) {
    #[cfg(windows)]
    {
        let process_id = process_id.to_string();
        let mut command = Command::new("taskkill.exe");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        process::configure_background_command(&mut command);
        let _ = command.status();
    }
    #[cfg(unix)]
    {
        let process_group = format!("-{process_id}");
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &process_group])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[derive(Debug, Error)]
enum AppError {
    #[error("Не удалось прочитать файл: {0}")]
    Io(#[from] std::io::Error),
    #[error("Файл превышает лимит 25 МБ.")]
    FileTooLarge,
    #[error("Текст превышает лимит 15 МБ.")]
    TextTooLarge,
    #[error("Для открытия .doc установите LibreOffice или soffice либо сохраните файл в .docx.")]
    ConverterUnavailable,
    #[error("LibreOffice не смог преобразовать файл .doc в .docx.")]
    ConversionFailed,
    #[error("Преобразование .doc превысило лимит времени 20 секунд.")]
    ConversionTimeout,
    #[error("Формат файла не поддерживается. Поддерживаются Word, ODT, PDF, RTF и текстовые файлы.")]
    UnsupportedFormat,
    #[error("Файл защищен паролем или зашифрован; извлечение без пароля недоступно.")]
    Encrypted,
    #[error("Не удалось разобрать документ: файл поврежден или имеет неподдерживаемую структуру.")]
    Malformed,
    #[error("В документе не найден доступный текст. PDF-сканы требуют OCR, которого пока нет.")]
    NoText,
    #[error("Текстовый файл не сохранен в UTF-8.")]
    InvalidTextEncoding,
    #[error("RTF использует неподдерживаемую кодовую страницу.")]
    UnsupportedRtfEncoding,
    #[error("Не удалось загрузить страницу: введите корректный адрес HTTP или HTTPS.")]
    InvalidUrl,
    #[error("В адресе страницы нельзя указывать имя пользователя или пароль.")]
    UrlCredentials,
    #[error("Загрузка страницы превысила лимит времени.")]
    UrlTimeout,
    #[error("Страница превышает лимит 4 МБ.")]
    UrlTooLarge,
    #[error("Страница перенаправляет слишком много раз.")]
    TooManyRedirects,
    #[error("Сервер вернул ошибку HTTP {0}.")]
    HttpStatus(u16),
    #[error("Страница имеет неподдерживаемый тип содержимого; ожидается HTML или обычный текст.")]
    UnsupportedWebContent,
    #[error("Не удалось загрузить страницу: {0}")]
    Network(String),
    #[error("Нет доступного текста для предварительного просмотра или анализа.")]
    EmptyText,
    #[error("Не удалось загрузить каталог правил: {0}")]
    RuleCatalog(String),
    #[error("Обработка документа была прервана.")]
    WorkerFailed,
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDocument {
    pub title: String,
    pub url: Option<String>,
    pub format: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_pdf_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_notice: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub rule_id: String,
    pub factor: String,
    pub title: String,
    pub excerpt: String,
    pub start: usize,
    pub end: usize,
    pub reason: String,
    pub confidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_confidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_rejection_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_reference_context: Option<InternalReferenceContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub completed_rules: usize,
    pub total_rules: usize,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSummary {
    pub id: String,
    pub title: String,
    pub factor: String,
    pub reason: String,
    pub confidence: String,
}

#[derive(Debug, Deserialize)]
struct RuleCatalog {
    version: u32,
    rules: Vec<RuleDefinition>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RuleDefinition {
    id: String,
    title: String,
    factor: String,
    reason: String,
    confidence: String,
    patterns: Vec<String>,
}

struct CompiledRule {
    definition: RuleDefinition,
    patterns: Vec<Regex>,
}

#[derive(Clone, Copy)]
enum XmlKind {
    Word,
    OpenDocument,
}

#[tauri::command]
async fn load_file(path: String) -> Result<LoadedDocument, String> {
    tokio::task::spawn_blocking(move || import_file(Path::new(&path)))
        .await
        .map_err(|_| AppError::WorkerFailed.to_string())?
}

#[tauri::command]
async fn load_url(url: String) -> Result<LoadedDocument, String> {
    import_url(&url).await
}

#[tauri::command]
fn save_report_pdf(title: String, bytes: Vec<u8>, app: tauri::AppHandle) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Не удалось создать PDF-отчёт: файл пуст.".into());
    }
    if bytes.len() > MAX_REPORT_PDF_BYTES {
        return Err("PDF-отчёт превышает допустимый размер.".into());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Не удалось определить папку «Загрузки»: {error}"))?;
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Не удалось открыть папку «Загрузки»: {error}"))?;

    let safe_title = title
        .chars()
        .filter_map(|character| {
            if character.is_alphanumeric() {
                Some(character)
            } else if character.is_whitespace() || matches!(character, '-' | '_') {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(80)
        .collect::<String>();
    let safe_title = if safe_title.is_empty() {
        "Документ"
    } else {
        &safe_title
    };
    let stem = format!("Отчёт-Норман-АЭ-{safe_title}");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    for suffix in 0..10_000_u32 {
        let file_name = if suffix == 0 {
            format!("{stem}-{timestamp}.pdf")
        } else {
            format!("{stem}-{timestamp}-{}.pdf", suffix + 1)
        };
        let path = downloads_dir.join(file_name);
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Не удалось сохранить PDF в «Загрузки»: {error}")),
        };

        if let Err(error) = file.write_all(&bytes) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("Не удалось записать PDF в «Загрузки»: {error}"));
        }
        return Ok(path.to_string_lossy().into_owned());
    }

    Err("Не удалось подобрать имя файла для PDF-отчёта.".into())
}

#[tauri::command]
fn get_system_memory_bytes() -> Result<u64, String> {
    system_memory_bytes()
}

#[cfg(target_os = "linux")]
fn system_memory_bytes() -> Result<u64, String> {
    let meminfo = fs::read_to_string("/proc/meminfo")
        .map_err(|error| format!("Не удалось определить объём памяти: {error}"))?;
    let total_kib = meminfo
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name != "MemTotal" {
                return None;
            }
            value.split_whitespace().next()?.parse::<u64>().ok()
        })
        .ok_or_else(|| "В системе не найден общий объём оперативной памяти.".to_string())?;
    Ok(total_kib.saturating_mul(1024))
}

#[cfg(target_os = "macos")]
fn system_memory_bytes() -> Result<u64, String> {
    let output = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .map_err(|error| format!("Не удалось определить объём памяти: {error}"))?;
    if !output.status.success() {
        return Err("macOS не вернула общий объём оперативной памяти.".into());
    }
    std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "macOS вернула некорректный объём оперативной памяти.".into())
}

#[cfg(target_os = "windows")]
fn system_memory_bytes() -> Result<u64, String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetPhysicallyInstalledSystemMemory(total_memory_in_kilobytes: *mut u64) -> i32;
    }

    let mut total_memory_in_kilobytes = 0u64;
    // The API writes the amount of physically installed memory in kilobytes.
    let success = unsafe { GetPhysicallyInstalledSystemMemory(&mut total_memory_in_kilobytes) };
    if success == 0 || total_memory_in_kilobytes == 0 {
        return Err("Windows не вернула общий объём оперативной памяти.".into());
    }
    Ok(total_memory_in_kilobytes.saturating_mul(1024))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn system_memory_bytes() -> Result<u64, String> {
    Err("Определение объёма памяти не поддерживается этой платформой.".into())
}

#[tauri::command]
async fn analyze_text(
    app: tauri::AppHandle,
    analysis_id: String,
    text: String,
    parallel_processes: Option<serde_json::Value>,
) -> Result<AnalysisResult, String> {
    if analysis_id.trim().is_empty() || analysis_id.len() > MAX_ANALYSIS_ID_BYTES {
        return Err("Не удалось определить запуск анализа.".into());
    }
    let parallel_processes = normalize_parallel_processes(parallel_processes);
    let control = app.state::<AnalysisPauseRegistry>().control(&analysis_id);
    let worker_analysis_id = analysis_id.clone();
    tokio::task::spawn_blocking(move || {
        analyze_document_with_pause(
            &text,
            parallel_processes,
            &control,
            &app,
            &worker_analysis_id,
            |progress| {
                let _ = app.emit("analysis-progress", progress);
            },
        )
    })
    .await
    .map_err(|_| AppError::WorkerFailed.to_string())?
}

#[tauri::command]
fn set_analysis_paused(
    app: tauri::AppHandle,
    analysis_id: String,
    paused: bool,
) -> Result<(), String> {
    if analysis_id.trim().is_empty() || analysis_id.len() > MAX_ANALYSIS_ID_BYTES {
        return Err("Не удалось определить запуск анализа.".into());
    }
    app.state::<AnalysisPauseRegistry>()
        .control(&analysis_id)
        .set_paused(paused);
    Ok(())
}

#[tauri::command]
fn release_analysis_pause(app: tauri::AppHandle, analysis_id: String) {
    app.state::<AnalysisPauseRegistry>().release(&analysis_id);
}

#[tauri::command]
fn cancel_ai_analysis(app: tauri::AppHandle, analysis_id: String) -> Result<(), String> {
    if analysis_id.trim().is_empty() || analysis_id.len() > MAX_ANALYSIS_ID_BYTES {
        return Err("Не удалось определить запуск анализа.".into());
    }
    app.state::<AnalysisPauseRegistry>().control(&analysis_id).cancel();
    Ok(())
}

#[tauri::command]
async fn retry_ai_finding_format(
    text: String,
    finding: Finding,
    model: String,
    parallel_processes: Option<serde_json::Value>,
    base_url: Option<String>,
) -> Result<Finding, String> {
    codex::retry_ai_finding_format(
        text,
        finding,
        model,
        parallel_processes,
        base_url,
    )
    .await
}

#[tauri::command]
fn get_rule_catalog() -> Result<Vec<RuleSummary>, String> {
    compiled_rules()
        .map(|rules| {
            rules
                .iter()
                .map(|rule| RuleSummary {
                    id: rule.definition.id.clone(),
                    title: rule.definition.title.clone(),
                    factor: rule.definition.factor.clone(),
                    reason: rule.definition.reason.clone(),
                    confidence: rule.definition.confidence.clone(),
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AnalysisPauseRegistry::default())
        .manage(norman::NormanSession::default())
        .setup(|app| {
            if cfg!(target_os = "windows") {
                app.get_webview_window("main")
                    .expect("main window is configured")
                    .set_decorations(false)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().state::<AnalysisPauseRegistry>().cancel_all();
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_file,
            load_url,
            analyze_text,
            set_analysis_paused,
            release_analysis_pause,
            cancel_ai_analysis,
            get_rule_catalog,
            get_system_memory_bytes,
            save_report_pdf,
            codex::get_codex_status,
            codex::analyze_with_codex,
            codex::get_claude_status,
            codex::analyze_with_claude,
            codex::get_ollama_status,
            codex::analyze_with_ollama,
            retry_ai_finding_format,
            codex::pull_ollama_model,
            ollama_setup::begin_ollama_setup,
            ollama_setup::cancel_ollama_setup,
            ollama_setup::install_ollama,
            ollama_setup::start_ollama,
            codex::get_cloudru_status,
            codex::analyze_with_cloudru,
            codex::get_yandex_status,
            codex::analyze_with_yandex,
            codex::analyze_with_norman,
            norman::norman_register,
            norman::norman_verify,
            norman::norman_login,
            norman::norman_me,
            norman::norman_logout
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Норман");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app_handle.state::<AnalysisPauseRegistry>().cancel_all();
        }
    });
}

pub fn import_file(path: &Path) -> Result<LoadedDocument, String> {
    load_file_inner(path).map_err(|error| error.to_string())
}

pub async fn import_url(url: &str) -> Result<LoadedDocument, String> {
    match tokio::time::timeout(Duration::from_secs(30), load_url_inner(url.to_string())).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => Err(AppError::UrlTimeout.to_string()),
    }
}

pub fn analyze_document(text: &str) -> Result<AnalysisResult, String> {
    analyze_document_with_progress(text, |_| {})
}

pub fn analyze_document_with_progress(
    text: &str,
    on_progress: impl FnMut(AnalysisProgress),
) -> Result<AnalysisResult, String> {
    analyze_document_with_progress_and_parallelism(text, 1, on_progress)
}

pub fn analyze_document_with_progress_and_parallelism(
    text: &str,
    parallel_processes: usize,
    on_progress: impl FnMut(AnalysisProgress),
) -> Result<AnalysisResult, String> {
    analyze_document_with_checkpoint(text, parallel_processes, on_progress, || {})
}

fn analyze_document_with_pause(
    text: &str,
    parallel_processes: usize,
    control: &AnalysisPauseControl,
    app: &tauri::AppHandle,
    analysis_id: &str,
    on_progress: impl FnMut(AnalysisProgress),
) -> Result<AnalysisResult, String> {
    analyze_document_with_checkpoint(text, parallel_processes, on_progress, || {
        control.checkpoint(app, analysis_id);
    })
}

fn analyze_document_with_checkpoint(
    text: &str,
    parallel_processes: usize,
    on_progress: impl FnMut(AnalysisProgress),
    checkpoint: impl FnMut(),
) -> Result<AnalysisResult, String> {
    let rules = compiled_rules().map_err(|error| error.to_string())?;
    let findings = analyze_with_parallelism(text, rules, parallel_processes, on_progress, checkpoint)
        .map_err(|error| error.to_string())?;
    Ok(AnalysisResult { findings })
}

fn load_file_inner(path: &Path) -> AppResult<LoadedDocument> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Err(AppError::FileTooLarge);
    }
    let (format, raw_text, mut preview_pdf_base64) = if matches!(extension.as_str(), "doc" | "dot") {
        (extension.as_str(), convert_legacy_doc(path)?, None)
    } else {
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(AppError::FileTooLarge);
        }
        match extension.as_str() {
            "docx" | "docm" | "dotx" | "dotm" => (
                extension.as_str(),
                extract_ooxml(&bytes, "word/document.xml", XmlKind::Word)?,
                None,
            ),
            "odt" => (
                "odt",
                extract_ooxml(&bytes, "content.xml", XmlKind::OpenDocument)?,
                None,
            ),
            "pdf" => ("pdf", extract_pdf(&bytes)?, Some(BASE64.encode(&bytes))),
            "rtf" => ("rtf", extract_rtf(&bytes)?, None),
            "txt" | "text" | "md" | "csv" => {
                ("txt", extract_plain_text(&bytes)?, None)
            }
            _ => return Err(AppError::UnsupportedFormat),
        }
    };
    let text = normalize_text(&raw_text);
    check_text(&text)?;

    let mut preview_notice = None;
    if matches!(extension.as_str(), "doc" | "dot" | "docx" | "docm" | "dotx" | "dotm" | "odt" | "rtf")
        && preview_pdf_base64.is_none()
    {
        match convert_preview_pdf_with_libreoffice(path) {
            Ok(bytes) => preview_pdf_base64 = Some(BASE64.encode(bytes)),
            Err(AppError::ConverterUnavailable) => {
                preview_notice = Some(
                    "Установите LibreOffice, чтобы увидеть исходное форматирование и изображения. Сейчас показан извлечённый текст."
                        .to_string(),
                );
            }
            Err(_) => {
                preview_notice = Some(
                    "Не удалось отобразить исходное форматирование. Сейчас показан извлечённый текст."
                        .to_string(),
                );
            }
        }
    }

    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("Документ");
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(name)
        .to_string();
    Ok(LoadedDocument {
        title,
        url: None,
        format: format.into(),
        text,
        preview_html: None,
        preview_pdf_base64,
        preview_notice,
    })
}

struct TemporaryDirectory(std::path::PathBuf);

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn convert_legacy_doc(path: &Path) -> AppResult<String> {
    let office_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        office_oxide::Document::open(path).map(|document| document.plain_text())
    }));
    match office_result {
        Ok(Ok(raw_text)) => {
            let text = normalize_text(&raw_text);
            if !text.is_empty() {
                check_text(&text)?;
                return Ok(text);
            }
        }
        Ok(Err(error)) => {
            let message = error.to_string().to_ascii_lowercase();
            if message.contains("encrypt") || message.contains("password") {
                return Err(AppError::Encrypted);
            }
        }
        Err(_) => {}
    }

    convert_legacy_doc_with_libreoffice(path)
}

fn libreoffice_programs() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            "libreoffice",
            "soffice",
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        &["libreoffice", "soffice"]
    }
}

fn convert_legacy_doc_with_libreoffice(path: &Path) -> AppResult<String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let directory = TemporaryDirectory(
        env::temp_dir().join(format!("norman-doc-{}-{nonce}", std::process::id())),
    );
    fs::create_dir(&directory.0)?;
    let mut converted_name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    converted_name.push_str(".docx");
    let output_path = directory.0.join(converted_name);
    let mut converter_found = false;

    for program in libreoffice_programs() {
        let mut command = Command::new(program);
        command
            .arg("--headless")
            .arg("--convert-to")
            .arg("docx")
            .arg("--outdir")
            .arg(&directory.0)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        process::configure_background_command(&mut command);
        let child = command.spawn();
        let mut child = match child {
            Ok(child) => {
                converter_found = true;
                child
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                converter_found = true;
                continue;
            }
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::ConversionTimeout);
            }
            thread::sleep(Duration::from_millis(100));
        };
        if status.success() && output_path.is_file() {
            let bytes = read_limited_file(&output_path)?;
            return extract_ooxml(&bytes, "word/document.xml", XmlKind::Word);
        }
    }

    if converter_found {
        Err(AppError::ConversionFailed)
    } else {
        Err(AppError::ConverterUnavailable)
    }
}

fn read_limited_file(path: &Path) -> AppResult<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Err(AppError::FileTooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::FileTooLarge);
    }
    Ok(bytes)
}

fn convert_preview_pdf_with_libreoffice(path: &Path) -> AppResult<Vec<u8>> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let directory = TemporaryDirectory(
        env::temp_dir().join(format!("norman-preview-{}-{nonce}", std::process::id())),
    );
    fs::create_dir(&directory.0)?;
    let output_name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let output_path = directory.0.join(format!("{output_name}.pdf"));
    let mut converter_found = false;

    for program in libreoffice_programs() {
        let mut command = Command::new(program);
        command
            .arg("--headless")
            .arg("--convert-to")
            .arg("pdf")
            .arg("--outdir")
            .arg(&directory.0)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        process::configure_background_command(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => {
                converter_found = true;
                child
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                converter_found = true;
                continue;
            }
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::ConversionTimeout);
            }
            thread::sleep(Duration::from_millis(100));
        };
        if status.success() && output_path.is_file() {
            return read_limited_file(&output_path);
        }
    }

    if converter_found {
        Err(AppError::ConversionFailed)
    } else {
        Err(AppError::ConverterUnavailable)
    }
}

fn supported_url_file_extension(filename: &str) -> Option<String> {
    let extension = Path::new(filename)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "doc" | "dot" | "docx" | "docm" | "dotx" | "dotm" | "odt" | "rtf" | "pdf"
            | "txt" | "text" | "md" | "csv"
    )
    .then_some(extension)
}

fn url_content_disposition_filename(value: &str) -> Option<String> {
    value.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.trim().split_once('=')?;
        let value = value.trim().trim_matches('"');
        if name.eq_ignore_ascii_case("filename*") {
            let encoded = value.split_once("''").map_or(value, |(_, value)| value);
            return url::form_urlencoded::parse(format!("filename={encoded}").as_bytes())
                .next()
                .map(|(_, filename)| filename.into_owned());
        }
        name.eq_ignore_ascii_case("filename").then(|| value.to_string())
    })
}

fn url_mime_file_extension(media_type: &str) -> Option<&'static str> {
    match media_type {
        "application/pdf" => Some("pdf"),
        "application/msword" | "application/vnd.ms-word" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-word.document.macroenabled.12" => Some("docm"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template" => Some("dotx"),
        "application/vnd.ms-word.template.macroenabled.12" => Some("dotm"),
        "application/vnd.oasis.opendocument.text" => Some("odt"),
        "application/rtf" | "text/rtf" | "application/x-rtf" => Some("rtf"),
        "text/markdown" => Some("md"),
        "text/csv" | "application/csv" => Some("csv"),
        _ => None,
    }
}

fn url_file_extension(
    current: &Url,
    media_type: &str,
    disposition: Option<&str>,
) -> Option<String> {
    let disposition_name = disposition.and_then(url_content_disposition_filename);
    let url_name = current
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|name| !name.is_empty());
    let names = [disposition_name.as_deref(), url_name]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    for name in &names {
        if let Some(extension) = supported_url_file_extension(name) {
            if !matches!(extension.as_str(), "txt" | "text" | "md" | "csv") {
                return Some(extension);
            }
        }
    }
    if let Some(extension) = url_mime_file_extension(media_type) {
        return Some(extension.to_string());
    }
    names.iter().find_map(|name| supported_url_file_extension(name))
}

fn load_url_file_inner(bytes: &[u8], extension: &str) -> AppResult<LoadedDocument> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let directory = TemporaryDirectory(
        env::temp_dir().join(format!("norman-url-{}-{nonce}", std::process::id())),
    );
    fs::create_dir(&directory.0)?;
    let path = directory.0.join(format!("source.{extension}"));
    fs::write(&path, bytes)?;
    load_file_inner(&path)
}

async fn load_url_inner(input: String) -> AppResult<LoadedDocument> {
    let original = validate_url(&input)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Norman/0.1")
        .build()
        .map_err(|error| AppError::Network(error.to_string()))?;
    let mut current = original.clone();

    for redirect_count in 0..=MAX_URL_REDIRECTS {
        let mut response = client
            .get(current.clone())
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            )
            .header(reqwest::header::ACCEPT_LANGUAGE, "ru-RU,ru;q=0.9,en;q=0.8")
            .send()
            .await
            .map_err(|error| AppError::Network(error.to_string()))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_URL_REDIRECTS {
                return Err(AppError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(AppError::InvalidUrl)?;
            current = validate_url(
                current
                    .join(location)
                    .map_err(|_| AppError::InvalidUrl)?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::HttpStatus(response.status().as_u16()));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let content_disposition = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if response
            .content_length()
            .is_some_and(|length| length > MAX_URL_BYTES as u64)
        {
            return Err(AppError::UrlTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| AppError::Network(error.to_string()))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_URL_BYTES {
                return Err(AppError::UrlTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }

        let media_type = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let file_extension = url_file_extension(
            &current,
            &media_type,
            content_disposition.as_deref(),
        );
        let is_html = matches!(media_type.as_str(), "text/html" | "application/xhtml+xml");
        let file_title = content_disposition
            .as_deref()
            .and_then(url_content_disposition_filename)
            .or_else(|| {
                current
                    .path_segments()
                    .and_then(|segments| segments.last())
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            })
            .or_else(|| current.host_str().map(str::to_string));
        let remote_url = current.to_string();
        let (title, text, format, preview_html, preview_pdf_base64, preview_notice) =
            tokio::task::spawn_blocking(move || {
                if file_extension.is_some() && !is_html {
                    let extension = file_extension
                        .as_deref()
                        .ok_or(AppError::UnsupportedWebContent)?;
                    let mut document = load_url_file_inner(&bytes, extension)?;
                    if let Some(filename) = file_title {
                        document.title = Path::new(&filename)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or(&filename)
                            .to_string();
                    }
                    return Ok::<_, AppError>((
                        document.title,
                        document.text,
                        document.format,
                        document.preview_html,
                        document.preview_pdf_base64,
                        document.preview_notice,
                    ));
                }
                let page = decode_web_text(&bytes, &content_type);
                let (title, text, format, preview_html) = match media_type.as_str() {
                    "text/html" | "application/xhtml+xml" => {
                        let (title, text) = extract_html_text(&page)?;
                        (title, text, "html".to_string(), Some(page))
                    }
                    "text/plain" => {
                        (String::new(), normalize_text(&page), "text".to_string(), None)
                    }
                    _ => return Err(AppError::UnsupportedWebContent),
                };
                let text = normalize_text(&text);
                check_text(&text)?;
                Ok::<_, AppError>((title, text, format, preview_html, None, None))
            })
            .await
            .map_err(|_| AppError::WorkerFailed)??;
        let fallback_title = current
            .host_str()
            .filter(|host| !host.is_empty())
            .unwrap_or("Страница")
            .to_string();
        let title = if title.trim().is_empty() {
            fallback_title
        } else {
            title
        };
        return Ok(LoadedDocument {
            title,
            url: Some(remote_url),
            format,
            text,
            preview_html,
            preview_pdf_base64,
            preview_notice,
        });
    }
    Err(AppError::TooManyRedirects)
}

fn validate_url(input: &str) -> AppResult<Url> {
    let url = Url::parse(input.trim()).map_err(|_| AppError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::InvalidUrl);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::UrlCredentials);
    }
    Ok(url)
}

fn decode_web_text(bytes: &[u8], content_type: &str) -> String {
    let label = content_type
        .split(';')
        .skip(1)
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            key.trim()
                .eq_ignore_ascii_case("charset")
                .then_some(value.trim().trim_matches(|character| character == '"' || character == '\''))
        });
    let encoding = label
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .unwrap_or(UTF_8);
    encoding.decode(bytes).0.into_owned()
}

fn extract_html_text(html: &str) -> AppResult<(String, String)> {
    let document = Html::parse_document(html);
    let title_selector = Selector::parse("title").map_err(|_| AppError::Malformed)?;
    let title = document
        .select(&title_selector)
        .next()
        .map(|node| normalize_text(&node.text().collect::<String>()))
        .unwrap_or_default();
    let mut raw_text = String::new();
    // Prefer legal document content over the site's navigation and footer.
    let content_root = [
        "#doc_content",
        "#document-content",
        "[itemprop=\"articleBody\"]",
        ".document-content",
        "article",
        "[role=\"main\"]",
        "main",
    ]
    .iter()
    .filter_map(|source| Selector::parse(source).ok())
    .find_map(|selector| {
        document
            .select(&selector)
            .next()
            .and_then(|element| document.tree.get(element.id()))
    });
    if let Some(root) = content_root {
        append_html_node(root, &mut raw_text);
    } else {
        for child in document.tree.root().children() {
            append_html_node(child, &mut raw_text);
        }
    }
    let text = normalize_text(&raw_text);
    if text.is_empty() {
        return Err(AppError::NoText);
    }
    Ok((title, text))
}

fn append_html_node(node: NodeRef<'_, Node>, output: &mut String) {
    match node.value() {
        Node::Text(text) => output.push_str(&text.text),
        Node::Element(element) => {
            let name = element.name();
            let class = element.attr("class").unwrap_or_default().to_lowercase();
            let id = element.attr("id").unwrap_or_default().to_lowercase();
            let is_advertisement = [
                "advertisement",
                "advertising",
                "ad-container",
                "ad-banner",
                "yandex-rtb",
                "reklama",
                "реклама",
            ]
            .iter()
            .any(|marker| class.contains(*marker) || id.contains(*marker))
                || element.attr("data-ad-slot").is_some()
                || element.attr("data-google-query-id").is_some();
            if matches!(
                name,
                "script" | "style" | "noscript" | "template" | "svg" | "canvas" | "iframe"
                    | "object" | "head"
            ) || element.attr("hidden").is_some()
                || element
                    .attr("aria-hidden")
                    .is_some_and(|value| value.eq_ignore_ascii_case("true"))
                || element.attr("class").is_some_and(|value| {
                    value.split_ascii_whitespace().any(|class| {
                        matches!(class, "hide" | "hidden" | "invisible")
                    })
                })
                || element.attr("style").is_some_and(|value| {
                    let style = value.to_ascii_lowercase().replace(' ', "");
                    style.contains("display:none") || style.contains("visibility:hidden")
                })
                || is_advertisement
            {
                return;
            }
            let block = matches!(
                name,
                "address"
                    | "article"
                    | "aside"
                    | "blockquote"
                    | "br"
                    | "dd"
                    | "div"
                    | "dl"
                    | "dt"
                    | "footer"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "header"
                    | "hr"
                    | "li"
                    | "main"
                    | "ol"
                    | "p"
                    | "pre"
                    | "section"
                    | "table"
                    | "td"
                    | "th"
                    | "tr"
                    | "ul"
            );
            if block
                && !output.is_empty()
                && !output.ends_with('\n')
                && !output.ends_with(' ')
            {
                output.push('\n');
            }
            for child in node.children() {
                append_html_node(child, output);
            }
            if block && !output.ends_with('\n') {
                output.push('\n');
            }
        }
        _ => {}
    }
}

fn extract_plain_text(bytes: &[u8]) -> AppResult<String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| AppError::InvalidTextEncoding)
}

fn extract_ooxml(bytes: &[u8], member: &str, kind: XmlKind) -> AppResult<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        if is_ole_container(bytes) {
            AppError::Encrypted
        } else {
            AppError::Malformed
        }
    })?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::FileTooLarge);
    }
    let mut entry = archive.by_name(member).map_err(|_| AppError::Malformed)?;
    if entry.encrypted() {
        return Err(AppError::Encrypted);
    }
    if entry.size() > MAX_XML_BYTES {
        return Err(AppError::FileTooLarge);
    }
    let mut xml_bytes = Vec::new();
    entry
        .by_ref()
        .take(MAX_XML_BYTES + 1)
        .read_to_end(&mut xml_bytes)?;
    if xml_bytes.len() as u64 > MAX_XML_BYTES {
        return Err(AppError::FileTooLarge);
    }
    let xml = std::str::from_utf8(&xml_bytes).map_err(|_| AppError::Malformed)?;
    let document = roxmltree::Document::parse(xml).map_err(|_| AppError::Malformed)?;
    let mut output = String::new();
    walk_xml(document.root(), kind, &mut output);
    Ok(output)
}

fn walk_xml(node: roxmltree::Node<'_, '_>, kind: XmlKind, output: &mut String) {
    if node.is_text() {
        output.push_str(node.text().unwrap_or_default());
        return;
    }
    if !node.is_element() {
        for child in node.children() {
            walk_xml(child, kind, output);
        }
        return;
    }

    let name = node.tag_name().name();
    if matches!(kind, XmlKind::Word) && matches!(name, "del" | "delText" | "instrText") {
        return;
    }
    match (kind, name) {
        (XmlKind::Word, "tab") | (XmlKind::OpenDocument, "tab") => output.push('\t'),
        (XmlKind::Word, "br") | (XmlKind::OpenDocument, "line-break") => output.push('\n'),
        (XmlKind::OpenDocument, "s") => {
            let count = node
                .attribute("c")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 10_000);
            output.extend(std::iter::repeat(' ').take(count));
        }
        _ => {
            for child in node.children() {
                walk_xml(child, kind, output);
            }
            if name == "p" {
                output.push('\n');
            }
        }
    }
}

fn extract_pdf(bytes: &[u8]) -> AppResult<String> {
    if bytes.windows(b"/Encrypt".len()).any(|part| part == b"/Encrypt") {
        return Err(AppError::Encrypted);
    }
    let extracted = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes))
        .map_err(|_| AppError::Malformed)?
        .map_err(|error| {
            if error.to_string().to_ascii_lowercase().contains("encrypt") {
                AppError::Encrypted
            } else {
                AppError::Malformed
            }
        })?;
    let text = normalize_text(&extracted);
    if text.is_empty() {
        return Err(AppError::NoText);
    }
    check_text(&text)?;
    Ok(text)
}

fn is_ole_container(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
}

fn extract_rtf(bytes: &[u8]) -> AppResult<String> {
    if !bytes.starts_with(b"{\\rtf") {
        return Err(AppError::Malformed);
    }
    let encrypted_markers: &[&[u8]] = &[b"\\crypt", b"\\encrypted"];
    if encrypted_markers
        .iter()
        .any(|marker| bytes.windows(marker.len()).any(|part| part == *marker))
    {
        return Err(AppError::Encrypted);
    }
    // shortcut: handles common controls and declared Windows code pages; use a full RTF parser if broader spec coverage is needed.
    let mut output = String::new();
    let mut raw = Vec::new();
    let mut group_skip = Vec::new();
    let mut group_first = Vec::new();
    let mut skip = false;
    let mut ignorable = false;
    let mut codepage = 1252;
    let mut unicode_fallback = 1usize;
    let mut fallback_left = 0usize;
    let mut pending_high = None;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
                group_skip.push(skip);
                group_first.push(true);
                index += 1;
            }
            b'}' => {
                flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
                skip = group_skip.pop().ok_or(AppError::Malformed)?;
                group_first.pop();
                index += 1;
            }
            b'\\' => {
                index += 1;
                let next = *bytes.get(index).ok_or(AppError::Malformed)?;
                if next.is_ascii_alphabetic() {
                    flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
                    let word_start = index;
                    while bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
                        index += 1;
                    }
                    let word = std::str::from_utf8(&bytes[word_start..index])
                        .map_err(|_| AppError::Malformed)?;
                    let mut number_end = index;
                    if bytes.get(number_end) == Some(&b'-') {
                        number_end += 1;
                    }
                    while bytes.get(number_end).is_some_and(u8::is_ascii_digit) {
                        number_end += 1;
                    }
                    let number = std::str::from_utf8(&bytes[index..number_end])
                        .ok()
                        .and_then(|value| value.parse::<i32>().ok());
                    index = number_end;
                    if bytes.get(index) == Some(&b' ') {
                        index += 1;
                    }

                    let at_group_start = group_first.last().copied().unwrap_or(false);
                    if let Some(first) = group_first.last_mut() {
                        *first = false;
                    }
                    if at_group_start && ignorable && is_rtf_destination(word) {
                        skip = true;
                    }
                    ignorable = false;
                    if word == "ansicpg" {
                        codepage = number.unwrap_or(codepage);
                    } else if word == "bin" {
                        let count = number.filter(|value| *value >= 0).ok_or(AppError::Malformed)? as usize;
                        index = index.checked_add(count).filter(|end| *end <= bytes.len()).ok_or(AppError::Malformed)?;
                    } else if !skip {
                        match word {
                            "par" | "line" | "row" => output.push('\n'),
                            "tab" | "cell" => output.push('\t'),
                            "uc" => unicode_fallback = number.unwrap_or(1).clamp(0, 32) as usize,
                            "u" => {
                                if let Some(value) = number {
                                    append_rtf_unit(&mut output, &mut pending_high, value as i16 as u16);
                                    fallback_left = unicode_fallback;
                                }
                            }
                            "emdash" => output.push('—'),
                            "endash" => output.push('–'),
                            "bullet" => output.push('•'),
                            "lquote" => output.push('‘'),
                            "rquote" => output.push('’'),
                            "ldblquote" => output.push('“'),
                            "rdblquote" => output.push('”'),
                            _ => {}
                        }
                    }
                } else if next == b'\'' {
                    flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
                    let end = index.checked_add(3).filter(|end| *end <= bytes.len()).ok_or(AppError::Malformed)?;
                    let hex = std::str::from_utf8(&bytes[index + 1..end])
                        .map_err(|_| AppError::Malformed)?;
                    let value = u8::from_str_radix(hex, 16).map_err(|_| AppError::Malformed)?;
                    if fallback_left > 0 {
                        fallback_left -= 1;
                    } else if !skip {
                        raw.push(value);
                    }
                    mark_rtf_group_started(&mut group_first);
                    index = end;
                } else {
                    flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
                    index += 1;
                    match next {
                        b'\\' | b'{' | b'}' => {
                            if fallback_left > 0 {
                                fallback_left -= 1;
                            } else if !skip {
                                flush_pending_rtf_unit(&mut output, &mut pending_high);
                                output.push(next as char);
                            }
                            mark_rtf_group_started(&mut group_first);
                        }
                        b'*' => ignorable = true,
                        b'~' if !skip && fallback_left == 0 => output.push(' '),
                        b'_' if !skip && fallback_left == 0 => output.push('‑'),
                        b'-' if !skip && fallback_left == 0 => {}
                        _ => {
                            if fallback_left > 0 {
                                fallback_left -= 1;
                            }
                        }
                    }
                }
            }
            b'\r' | b'\n' => index += 1,
            byte => {
                if fallback_left > 0 {
                    fallback_left -= 1;
                } else if !skip {
                    raw.push(byte);
                }
                index += 1;
                mark_rtf_group_started(&mut group_first);
            }
        }
    }
    flush_rtf_bytes(&mut raw, &mut output, codepage, skip)?;
    if !group_skip.is_empty() {
        return Err(AppError::Malformed);
    }
    flush_pending_rtf_unit(&mut output, &mut pending_high);
    Ok(output)
}

fn is_rtf_destination(word: &str) -> bool {
    matches!(
        word,
        "fonttbl"
            | "colortbl"
            | "stylesheet"
            | "info"
            | "pict"
            | "object"
            | "header"
            | "footer"
            | "filetbl"
            | "listtable"
            | "listoverridetable"
            | "revtbl"
            | "generator"
            | "xmlnstbl"
            | "themedata"
            | "colorschememapping"
    )
}

fn mark_rtf_group_started(group_first: &mut [bool]) {
    if let Some(first) = group_first.last_mut() {
        *first = false;
    }
}

fn flush_rtf_bytes(raw: &mut Vec<u8>, output: &mut String, codepage: i32, skip: bool) -> AppResult<()> {
    if raw.is_empty() {
        return Ok(());
    }
    if !skip {
        let label = if codepage == 65001 {
            "utf-8".to_string()
        } else {
            format!("windows-{codepage}")
        };
        let encoding = Encoding::for_label(label.as_bytes()).ok_or(AppError::UnsupportedRtfEncoding)?;
        output.push_str(&encoding.decode(raw).0);
    }
    raw.clear();
    Ok(())
}

fn append_rtf_unit(output: &mut String, pending_high: &mut Option<u16>, unit: u16) {
    if (0xd800..=0xdbff).contains(&unit) {
        flush_pending_rtf_unit(output, pending_high);
        *pending_high = Some(unit);
    } else if (0xdc00..=0xdfff).contains(&unit) {
        if let Some(high) = pending_high.take() {
            let codepoint = 0x1_0000 + (((high as u32 - 0xd800) << 10) | (unit as u32 - 0xdc00));
            if let Some(value) = char::from_u32(codepoint) {
                output.push(value);
            }
        } else {
            output.push('�');
        }
    } else {
        flush_pending_rtf_unit(output, pending_high);
        if let Some(value) = char::from_u32(unit as u32) {
            output.push(value);
        }
    }
}

fn flush_pending_rtf_unit(output: &mut String, pending_high: &mut Option<u16>) {
    if pending_high.take().is_some() {
        output.push('�');
    }
}

fn normalize_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(MAX_TEXT_BYTES));
    for ch in input.chars() {
        if ch == '\0' {
            continue;
        }
        if ch == '\r' || ch == '\n' {
            while output.ends_with(' ') {
                output.pop();
            }
            if !output.ends_with('\n') {
                output.push('\n');
            }
        } else if ch.is_whitespace() {
            if !output.ends_with(' ') && !output.ends_with('\n') {
                output.push(' ');
            }
        } else {
            output.push(ch);
        }
    }
    output.trim().to_string()
}

fn check_text(text: &str) -> AppResult<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(AppError::TextTooLarge);
    }
    if text.trim().is_empty() {
        return Err(AppError::EmptyText);
    }
    Ok(())
}

fn compiled_rules() -> AppResult<&'static [CompiledRule]> {
    static CATALOG: OnceLock<Result<Vec<CompiledRule>, String>> = OnceLock::new();
    match CATALOG.get_or_init(load_rules).as_ref() {
        Ok(rules) => Ok(rules),
        Err(error) => Err(AppError::RuleCatalog(error.clone())),
    }
}

fn load_rules() -> Result<Vec<CompiledRule>, String> {
    let catalog: RuleCatalog = serde_json::from_str(RULES_JSON).map_err(|error| error.to_string())?;
    if catalog.version != 1 || catalog.rules.is_empty() {
        return Err("unsupported or empty catalog".into());
    }
    catalog
        .rules
        .into_iter()
        .map(|definition| {
            if definition.id.trim().is_empty()
                || definition.title.trim().is_empty()
                || definition.factor.trim().is_empty()
                || definition.patterns.is_empty()
            {
                return Err(format!("invalid rule {}", definition.id));
            }
            let patterns = definition
                .patterns
                .iter()
                .map(|pattern| {
                    RegexBuilder::new(pattern)
                        .case_insensitive(true)
                        .size_limit(2 * 1024 * 1024)
                        .dfa_size_limit(2 * 1024 * 1024)
                        .build()
                        .map_err(|error| format!("{}: {error}", definition.id))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(CompiledRule {
                definition,
                patterns,
            })
        })
        .collect()
}

#[cfg(test)]
fn analyze(
    text: &str,
    rules: &[CompiledRule],
    on_progress: impl FnMut(AnalysisProgress),
) -> AppResult<Vec<Finding>> {
    analyze_with_parallelism(text, rules, 1, on_progress, || {})
}

fn analyze_with_parallelism(
    text: &str,
    rules: &[CompiledRule],
    parallel_processes: usize,
    mut on_progress: impl FnMut(AnalysisProgress),
    mut checkpoint: impl FnMut(),
) -> AppResult<Vec<Finding>> {
    check_text(text)?;
    let offsets = OffsetMap::new(text);
    let mut findings = Vec::new();
    let worker_count = parallel_processes
        .clamp(1, MAX_PARALLEL_PROCESSES)
        .min(rules.len().max(1));
    let mut next_rule = 0;

    while next_rule < rules.len() {
        checkpoint();
        let remaining = MAX_FINDINGS.saturating_sub(findings.len());
        if remaining == 0 {
            for rule_index in next_rule..rules.len() {
                on_progress(AnalysisProgress {
                    completed_rules: rule_index + 1,
                    total_rules: rules.len(),
                    findings: Vec::new(),
                });
            }
            break;
        }

        let batch_size = worker_count.min(rules.len() - next_rule);
        let can_parallelize = worker_count > 1
            && batch_size.saturating_mul(MAX_FINDINGS_PER_RULE) <= remaining;
        let batch_findings = if can_parallelize {
            thread::scope(|scope| {
                let offsets = &offsets;
                let handles = rules[next_rule..next_rule + batch_size]
                    .iter()
                    .map(|rule| {
                        scope.spawn(move || analyze_rule(text, offsets, rule, MAX_FINDINGS_PER_RULE))
                    })
                    .collect::<Vec<_>>();
                let mut results = Vec::with_capacity(handles.len());
                let mut worker_failed = false;
                for handle in handles {
                    match handle.join() {
                        Ok(result) => results.push(result),
                        Err(_) => worker_failed = true,
                    }
                }
                if worker_failed {
                    Err(AppError::WorkerFailed)
                } else {
                    Ok(results)
                }
            })?
        } else {
            vec![analyze_rule(
                text,
                &offsets,
                &rules[next_rule],
                remaining.min(MAX_FINDINGS_PER_RULE),
            )]
        };

        for added in batch_findings {
            findings.extend(added.iter().cloned());
            on_progress(AnalysisProgress {
                completed_rules: next_rule + 1,
                total_rules: rules.len(),
                findings: added,
            });
            next_rule += 1;
        }
    }
    findings.sort_by(|left, right| {
        (left.start, left.end, &left.rule_id).cmp(&(right.start, right.end, &right.rule_id))
    });
    Ok(findings)
}

fn analyze_rule(
    text: &str,
    offsets: &OffsetMap,
    rule: &CompiledRule,
    match_limit: usize,
) -> Vec<Finding> {
    let mut seen = HashSet::new();
    let mut new_findings: Vec<Finding> = Vec::new();
    for pattern in &rule.patterns {
        for matched in pattern.find_iter(text) {
            if seen.insert((matched.start(), matched.end())) {
                let start = offsets.at(text, matched.start());
                let end = offsets.at(text, matched.end());
                let finding = Finding {
                    id: format!("{}:{start}:{end}", rule.definition.id),
                    rule_id: rule.definition.id.clone(),
                    factor: rule.definition.factor.clone(),
                    title: rule.definition.title.clone(),
                    excerpt: text[matched.start()..matched.end()].to_string(),
                    start,
                    end,
                    reason: rule.definition.reason.clone(),
                    confidence: rule.definition.confidence.clone(),
                    origin: None,
                    ai_confidence: None,
                    ai_rationale: None,
                    ai_rejection_reason: None,
                    ai_error: None,
                    ai_error_kind: None,
                    internal_reference_context: if rule.definition.id == "AE-REF-02" {
                        internal_reference_context(
                            text,
                            start,
                            &text[matched.start()..matched.end()],
                        )
                    } else {
                        None
                    },
                };
                let overlap_indexes = new_findings
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| {
                        (start < item.end && item.start < end).then_some(index)
                    })
                    .collect::<Vec<_>>();
                if overlap_indexes.is_empty() {
                    new_findings.push(finding);
                } else {
                    let mut longest = finding;
                    for &index in &overlap_indexes {
                        if new_findings[index].end - new_findings[index].start
                            > longest.end - longest.start
                        {
                            longest = new_findings[index].clone();
                        }
                    }
                    for index in overlap_indexes.into_iter().rev() {
                        new_findings.remove(index);
                    }
                    new_findings.push(longest);
                }
                if new_findings.len() >= match_limit {
                    break;
                }
            }
        }
        if new_findings.len() >= match_limit {
            break;
        }
    }
    new_findings
}

#[derive(Clone, Copy)]
struct OffsetCheckpoint {
    byte: usize,
    utf16: usize,
}

struct OffsetMap {
    checkpoints: Vec<OffsetCheckpoint>,
}

impl OffsetMap {
    fn new(text: &str) -> Self {
        let mut checkpoints = vec![OffsetCheckpoint { byte: 0, utf16: 0 }];
        let mut utf16 = 0;
        let mut next_checkpoint = 1024;
        for (byte, character) in text.char_indices() {
            if byte >= next_checkpoint {
                checkpoints.push(OffsetCheckpoint { byte, utf16 });
                next_checkpoint = byte + 1024;
            }
            utf16 += character.len_utf16();
        }
        Self { checkpoints }
    }

    fn at(&self, text: &str, byte: usize) -> usize {
        let insertion = self
            .checkpoints
            .partition_point(|checkpoint| checkpoint.byte <= byte);
        let checkpoint = self.checkpoints[insertion.saturating_sub(1)];
        checkpoint.utf16 + text[checkpoint.byte..byte].encode_utf16().count()
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InternalReferenceContext {
    pub(crate) citing_block: Option<ReferenceBlockSpan>,
    pub(crate) referenced_blocks: Vec<ReferenceBlockSpan>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceBlockSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

#[derive(Clone)]
struct ProvisionMarker {
    start: usize,
    level: u8,
    article: Option<String>,
    part: Option<String>,
    point: Option<String>,
}

fn internal_reference_regex() -> &'static Regex {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    REFERENCE.get_or_init(|| {
        Regex::new(r"(?i)(?:(?:пункт(?:е|а|у|ом|ы|ов|ам|ах)\s+(?P<point>\d+(?:\.\d+)*))\s+)?(?:(?:част(?:и|ью|ь|ях|ей)\s+(?P<part>\d+(?:\.\d+)*))\s+)?стать(?:е|и|ю|ёй|ей)\s+(?P<article>\d+(?:\.\d+)*)\s+настоящ(?:его|ей|ую|ему|им)\s+(?:Федеральн(?:ого|ой)\s+закона|ФЗ|закона|кодекс(?:а|е|у|ом)|документ(?:а|е|у|ом))")
            .expect("valid internal-reference regex")
    })
}

fn provision_line_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)^статья\s+(\d+(?:\.\d+)*)\b",
            r"^(\d+(?:\.\d+)*)\.(?:\s|$)",
            r"^(\d+(?:\.\d+)*)\)(?:\s|$)",
            r"(?i)^([а-яё])\)(?:\s|$)",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("valid provision-line regex"))
        .collect()
    })
}

pub(crate) fn internal_reference_context(
    text: &str,
    start_utf16: usize,
    excerpt: &str,
) -> Option<InternalReferenceContext> {
    let captures = internal_reference_regex().captures(excerpt)?;
    let article = captures.name("article")?.as_str();
    let part = captures.name("part").map(|value| value.as_str());
    let point = captures.name("point").map(|value| value.as_str());
    let source_start = byte_at_utf16_offset(text, start_utf16)?;
    let markers = provision_markers(text);
    let offset_map = OffsetMap::new(text);
    let citing_block = markers
        .iter()
        .enumerate()
        .filter(|(_, marker)| marker.start <= source_start && marker.level <= 2)
        .last()
        .map(|(index, _)| provision_block_span(text, &markers, index, &offset_map));
    let referenced_blocks = markers
        .iter()
        .enumerate()
        .filter(|(_, marker)| {
            if marker.article.as_deref() != Some(article) {
                return false;
            }
            match (part, point, marker.level) {
                (Some(wanted_part), Some(wanted_point), 2) => {
                    marker.part.as_deref() == Some(wanted_part)
                        && marker.point.as_deref() == Some(wanted_point)
                }
                (None, Some(wanted_point), 2) => marker.point.as_deref() == Some(wanted_point),
                (Some(wanted_part), None, 1) => marker.part.as_deref() == Some(wanted_part),
                (None, None, 0) => true,
                _ => false,
            }
        })
        .map(|(index, _)| provision_block_span(text, &markers, index, &offset_map))
        .collect();

    Some(InternalReferenceContext {
        citing_block,
        referenced_blocks,
    })
}

pub(crate) fn internal_reference_blocks(
    text: &str,
    context: &InternalReferenceContext,
) -> (Option<String>, Vec<String>) {
    let block_text = |span: &ReferenceBlockSpan| {
        let start = byte_at_utf16_offset(text, span.start)?;
        let end = byte_at_utf16_offset(text, span.end)?;
        text.get(start..end).map(|block| block.trim().to_string())
    };
    (
        context.citing_block.as_ref().and_then(block_text),
        context
            .referenced_blocks
            .iter()
            .filter_map(block_text)
            .collect(),
    )
}

fn byte_at_utf16_offset(text: &str, offset: usize) -> Option<usize> {
    let mut utf16 = 0;
    for (byte, character) in text.char_indices() {
        if utf16 == offset {
            return Some(byte);
        }
        utf16 += character.len_utf16();
        if utf16 > offset {
            return None;
        }
    }
    (utf16 == offset).then_some(text.len())
}

fn provision_markers(text: &str) -> Vec<ProvisionMarker> {
    let patterns = provision_line_patterns();
    let mut markers = Vec::new();
    let mut article = None;
    let mut part = None;
    let mut point = None;
    let mut start = 0;

    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let (level, number) = if let Some(captures) = patterns[0].captures(trimmed) {
            (0, captures[1].to_string())
        } else if let Some(captures) = patterns[1].captures(trimmed) {
            (1, captures[1].to_string())
        } else if let Some(captures) = patterns[2].captures(trimmed) {
            (2, captures[1].to_string())
        } else if let Some(captures) = patterns[3].captures(trimmed) {
            (3, captures[1].to_string())
        } else {
            start += line.len();
            continue;
        };

        match level {
            0 => {
                article = Some(number.clone());
                part = None;
                point = None;
            }
            1 => {
                part = Some(number.clone());
                point = None;
            }
            2 => point = Some(number.clone()),
            _ => {}
        }
        markers.push(ProvisionMarker {
            start,
            level,
            article: article.clone(),
            part: part.clone(),
            point: point.clone(),
        });
        start += line.len();
    }
    markers
}

fn provision_block_span(
    text: &str,
    markers: &[ProvisionMarker],
    index: usize,
    offsets: &OffsetMap,
) -> ReferenceBlockSpan {
    let marker = &markers[index];
    let end = markers[index + 1..]
        .iter()
        .find(|next| next.level <= marker.level)
        .map_or(text.len(), |next| next.start);
    ReferenceBlockSpan {
        start: offsets.at(text, marker.start),
        end: offsets.at(text, end),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        analyze, byte_at_utf16_offset, compiled_rules, extract_html_text, extract_ooxml,
        extract_rtf, internal_reference_blocks, internal_reference_context, load_file_inner,
        normalize_text, CompiledRule, RuleDefinition, XmlKind,
    };
    use base64::Engine as _;
    use regex::Regex;
    use std::{fs, io::Write, path::PathBuf, time::SystemTime};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("norman-preview-test-{nonce}"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_ooxml(path: &PathBuf, member: &str, xml: &str) {
        let file = fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(member, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(xml.as_bytes()).unwrap();
        archive.finish().unwrap();
    }

    fn synthetic_pdf_with_image() -> Vec<u8> {
        let page_content = b"q 36 0 0 36 500 700 cm /Im1 Do Q\nBT /F1 12 Tf 72 720 Td (PDF heading) Tj ET\n";
        let mut content_stream = format!("<< /Length {} >>\nstream\n", page_content.len()).into_bytes();
        content_stream.extend_from_slice(page_content);
        content_stream.extend_from_slice(b"endstream");
        let image_stream = [
            b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n".as_slice(),
            &[0xff, 0x00, 0x00],
            b"\nendstream",
        ]
        .concat();
        let objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>".to_vec(),
            content_stream,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            image_stream,
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            write!(&mut bytes, "{} 0 obj\n", index + 1).unwrap();
            bytes.extend_from_slice(object);
            bytes.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = bytes.len();
        write!(&mut bytes, "xref\n0 {}\n", offsets.len()).unwrap();
        bytes.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            write!(&mut bytes, "{offset:010} 00000 n \n").unwrap();
        }
        write!(
            &mut bytes,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            offsets.len()
        )
        .unwrap();
        bytes
    }

    #[test]
    fn supported_document_extractors_keep_readable_text_and_offsets() {
        let word_xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>"#;
        let odt_xml = r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Heading</text:p><text:p>Body text</text:p></office:text></office:body></office:document-content>"#;
        assert_eq!(
            normalize_text(&extract_ooxml(word_xml.as_bytes(), "unused", XmlKind::Word).unwrap()),
            "Heading\nBody text"
        );
        assert_eq!(
            normalize_text(&extract_ooxml(odt_xml.as_bytes(), "unused", XmlKind::OpenDocument).unwrap()),
            "Heading\nBody text"
        );
        assert_eq!(
            normalize_text(extract_rtf(br#"{\rtf1\ansi Heading\par Body text}"#).unwrap().as_str()),
            "Heading\nBody text"
        );
        let plain = normalize_text("Заголовок\r\nBody text");
        let body_offset = plain.encode_utf16().take_while(|_| true).count() - "Body text".encode_utf16().count();
        assert_eq!(&plain.encode_utf16().skip(body_offset).collect::<Vec<_>>(), &"Body text".encode_utf16().collect::<Vec<_>>());
    }

    #[test]
    fn pdf_import_returns_original_bytes_for_page_preview_and_preserves_text() {
        let directory = TestDirectory::new();
        let path = directory.0.join("sample.pdf");
        let bytes = synthetic_pdf_with_image();
        fs::write(&path, &bytes).unwrap();

        let loaded = load_file_inner(&path).unwrap();
        assert_eq!(loaded.format, "pdf");
        assert!(loaded.text.contains("PDF heading"));
        let encoded = loaded.preview_pdf_base64.expect("PDF preview bytes");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap(), bytes);
        assert!(loaded.preview_notice.is_none());
    }

    #[test]
    fn docx_odt_rtf_and_text_imports_keep_text_fallbacks() {
        let directory = TestDirectory::new();
        let docx_path = directory.0.join("sample.docx");
        write_ooxml(
            &docx_path,
            "word/document.xml",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>"#,
        );
        let odt_path = directory.0.join("sample.odt");
        write_ooxml(
            &odt_path,
            "content.xml",
            r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Heading</text:p><text:p>Body</text:p></office:text></office:body></office:document-content>"#,
        );
        let rtf_path = directory.0.join("sample.rtf");
        fs::write(&rtf_path, br#"{\rtf1\ansi Heading\par Body}"#).unwrap();
        let text_path = directory.0.join("sample.txt");
        fs::write(&text_path, b"Heading\r\nBody").unwrap();

        for (path, format) in [
            (&docx_path, "docx"),
            (&odt_path, "odt"),
            (&rtf_path, "rtf"),
            (&text_path, "txt"),
        ] {
            let loaded = load_file_inner(path).unwrap();
            assert_eq!(loaded.format, format);
            assert_eq!(loaded.text, "Heading\nBody");
            if format == "txt" {
                assert!(loaded.preview_pdf_base64.is_none());
                assert!(loaded.preview_notice.is_none());
            } else {
                assert!(loaded.preview_pdf_base64.is_some() || loaded.preview_notice.is_some());
            }
        }
    }

    #[test]
    fn risk_rule_catalog_compiles_and_matches_cyrillic_domains() {
        let text = "Закупки налоговым антимонопольные банкротства несостоятельность рекламный таможня валютный контроль";
        let findings = analyze(text, compiled_rules().unwrap(), |_| {}).unwrap();
        let risk_excerpts = [
            "Закупки",
            "налоговым",
            "антимонопольные",
            "банкротства",
            "несостоятельность",
            "рекламный",
            "таможня",
            "валютный контроль",
        ];

        for excerpt in risk_excerpts {
            assert!(
                findings
                    .iter()
                    .any(|finding| finding.rule_id == "AE-RISK-01" && finding.excerpt == excerpt),
                "AE-RISK-01 should detect {excerpt:?}"
            );
        }
    }

    #[test]
    fn housing_code_example_reports_discretion_and_linguistic_uncertainty() {
        let text = include_str!("../../fixtures/housing-code-162-part-12.txt");
        let findings = analyze(text, compiled_rules().unwrap(), |_| {}).unwrap();
        let example = "может быть предусмотрено иное распределение";
        let discretion = findings.iter().find(|finding| finding.rule_id == "AE-DIS-01").unwrap();
        let linguistic = findings.iter().find(|finding| finding.rule_id == "AE-LEX-01").unwrap();
        assert!(discretion.excerpt.to_lowercase().contains(example));
        assert!(example.contains(&linguistic.excerpt.to_lowercase()));
        for finding in [discretion, linguistic] {
            let start = byte_at_utf16(text, finding.start);
            let end = byte_at_utf16(text, finding.end);
            assert_eq!(
                &text[start..end],
                finding.excerpt.as_str(),
                "finding offsets must point to exact preview text"
            );
        }
    }

    #[test]
    fn internal_reference_signal_resolves_both_complete_point_blocks() {
        let text = "Статья 3. Перечень.\n1. Первая часть.\n1) Первый пункт.\n2) Второй пункт.\n3) Органами, организациями и их должностными лицами — в соответствии с настоящим Федеральным законом, в установленном порядке.\nПродолжение пункта 3.\n(в ред. Федерального закона от 30.09.2024 N 334-ФЗ)\n4) Четвертый пункт.\nСтатья 5. Запрет.\n1. Общая часть.\n1.1. Независимая экспертиза.\n3) Гражданам, осуществляющим деятельность в органах, указанных в пункте 3 части 1 статьи 3 настоящего Федерального закона, запрещено проводить экспертизу.\nПродолжение пункта 3 статьи 5.\n4) Следующий пункт.\n";
        let findings = analyze(text, compiled_rules().unwrap(), |_| {}).unwrap();
        let finding = findings
            .iter()
            .find(|finding| finding.rule_id == "AE-REF-02")
            .expect("internal self-reference should produce a review signal");
        assert_eq!(
            finding.excerpt,
            "пункте 3 части 1 статьи 3 настоящего Федерального закона"
        );
        assert!(finding.internal_reference_context.is_some());
        let context = internal_reference_context(text, finding.start, &finding.excerpt)
            .expect("recognized self-reference should resolve its provision context");
        let (citing_block, referenced_blocks) = internal_reference_blocks(text, &context);
        assert_eq!(
            citing_block.as_deref(),
            Some("3) Гражданам, осуществляющим деятельность в органах, указанных в пункте 3 части 1 статьи 3 настоящего Федерального закона, запрещено проводить экспертизу.\nПродолжение пункта 3 статьи 5.")
        );
        assert_eq!(referenced_blocks.len(), 1);
        assert_eq!(
            referenced_blocks[0],
            "3) Органами, организациями и их должностными лицами — в соответствии с настоящим Федеральным законом, в установленном порядке.\nПродолжение пункта 3.\n(в ред. Федерального закона от 30.09.2024 N 334-ФЗ)"
        );
        let byte_start = byte_at_utf16_offset(text, finding.start).unwrap();
        assert_eq!(
            &text[byte_start..byte_start + finding.excerpt.len()],
            finding.excerpt,
            "reference excerpt must retain exact source location"
        );
    }

    #[test]
    fn html_analysis_uses_document_content_and_skips_hidden_site_chrome() {
        let html = r#"
            <html><head><title>Страница</title></head><body>
              <nav>Навигация сайта</nav>
              <main><article><h1>Заголовок</h1>
                <div id="doc_content"><p>Текст нормативного акта.</p>
                  <div class="popup-social hide">РЕКЛАМА</div>
                </div>
              </article></main>
              <footer>Реклама на портале</footer>
            </body></html>
        "#;
        let (_, text) = extract_html_text(html).unwrap();

        assert!(text.contains("Текст нормативного акта."));
        assert!(!text.contains("Навигация сайта"));
        assert!(!text.contains("РЕКЛАМА"));
        assert!(!text.contains("Реклама на портале"));
    }

    #[test]
    fn overlapping_patterns_for_one_rule_keep_only_the_longest_match() {
        let short = Regex::new("abc|def").unwrap();
        let long = Regex::new("bcde").unwrap();
        let rule = CompiledRule {
            definition: RuleDefinition {
                id: "TEST-REF".into(),
                title: "Тестовая отсылка".into(),
                factor: "Тест".into(),
                reason: "Проверка".into(),
                confidence: "Низкая".into(),
                patterns: vec!["abc|def".into(), "bcde".into()],
            },
            patterns: vec![short, long],
        };
        let findings = analyze("abcdef", &[rule], |_| {}).unwrap();

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].excerpt, "bcde");
    }

    fn byte_at_utf16(text: &str, offset: usize) -> usize {
        let mut utf16 = 0;
        for (byte, character) in text.char_indices() {
            if utf16 == offset {
                return byte;
            }
            utf16 += character.len_utf16();
        }
        text.len()
    }
}
