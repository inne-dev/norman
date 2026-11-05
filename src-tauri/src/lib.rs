use std::{
    collections::HashSet,
    env, fs::{self, File},
    io::{Cursor, Read},
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ego_tree::NodeRef;
use encoding_rs::{Encoding, UTF_8};
use regex::{Regex, RegexBuilder};
use scraper::{Html, Node, Selector};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use thiserror::Error;
use url::Url;

mod codex;

const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 15 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_URL_BYTES: usize = 4 * 1024 * 1024;
const MAX_URL_REDIRECTS: usize = 5;
const MAX_FINDINGS: usize = 500;
const MAX_FINDINGS_PER_RULE: usize = 40;
const MAX_PARALLEL_PROCESSES: usize = 4;
const RULES_JSON: &str = include_str!("../../data/rules.json");

pub(super) fn normalize_parallel_processes(value: Option<serde_json::Value>) -> usize {
    value
        .and_then(|value| value.as_u64())
        .filter(|count| (1..=MAX_PARALLEL_PROCESSES as u64).contains(count))
        .map(|count| count as usize)
        .unwrap_or(1)
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
    pub checklist: Vec<String>,
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
async fn analyze_text(
    app: tauri::AppHandle,
    text: String,
    parallel_processes: Option<serde_json::Value>,
) -> Result<AnalysisResult, String> {
    let parallel_processes = normalize_parallel_processes(parallel_processes);
    tokio::task::spawn_blocking(move || {
        analyze_document_with_progress_and_parallelism(&text, parallel_processes, |progress| {
            let _ = app.emit("analysis-progress", progress);
        })
    })
    .await
    .map_err(|_| AppError::WorkerFailed.to_string())?
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_file,
            load_url,
            analyze_text,
            get_rule_catalog,
            codex::get_codex_status,
            codex::analyze_with_codex
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Норман");
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
    let rules = compiled_rules().map_err(|error| error.to_string())?;
    let findings = analyze_with_parallelism(text, rules, parallel_processes, on_progress)
        .map_err(|error| error.to_string())?;
    Ok(AnalysisResult {
        findings,
        checklist: vec![
            "Проверьте орган издания и его полномочия по первичному источнику.".into(),
            "Проверьте дату вступления в силу и сведения об официальном опубликовании.".into(),
            "Сопоставьте положения со связанными актами и проверьте компетенцию.".into(),
            "Проверьте полноту процедуры с учетом связанных актов и материалов.".into(),
        ],
    })
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
    let (format, raw_text) = if matches!(extension.as_str(), "doc" | "dot") {
        (extension.as_str(), convert_legacy_doc(path)?)
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
            ),
            "odt" => ("odt", extract_ooxml(&bytes, "content.xml", XmlKind::OpenDocument)?),
            "pdf" => ("pdf", extract_pdf(&bytes)?),
            "rtf" => ("rtf", extract_rtf(&bytes)?),
            "txt" | "text" | "md" | "csv" => ("txt", extract_plain_text(&bytes)?),
            _ => return Err(AppError::UnsupportedFormat),
        }
    };
    let text = normalize_text(&raw_text);
    check_text(&text)?;

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

    for program in ["libreoffice", "soffice"] {
        let child = Command::new(program)
            .arg("--headless")
            .arg("--convert-to")
            .arg("docx")
            .arg("--outdir")
            .arg(&directory.0)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
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
        let (title, text, format, preview_html) = tokio::task::spawn_blocking(move || {
            let page = decode_web_text(&bytes, &content_type);
            let (title, text, format, preview_html) = match media_type.as_str() {
                "text/html" | "application/xhtml+xml" => {
                    let (title, text) = extract_html_text(&page)?;
                    (title, text, "html", Some(page))
                }
                "text/plain" => (String::new(), normalize_text(&page), "text", None),
                _ => return Err(AppError::UnsupportedWebContent),
            };
            let text = normalize_text(&text);
            check_text(&text)?;
            Ok::<_, AppError>((title, text, format, preview_html))
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
            url: Some(current.to_string()),
            format: format.into(),
            text,
            preview_html,
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

fn analyze(
    text: &str,
    rules: &[CompiledRule],
    on_progress: impl FnMut(AnalysisProgress),
) -> AppResult<Vec<Finding>> {
    analyze_with_parallelism(text, rules, 1, on_progress)
}

fn analyze_with_parallelism(
    text: &str,
    rules: &[CompiledRule],
    parallel_processes: usize,
    mut on_progress: impl FnMut(AnalysisProgress),
) -> AppResult<Vec<Finding>> {
    check_text(text)?;
    let offsets = OffsetMap::new(text);
    let mut findings = Vec::new();
    let worker_count = parallel_processes
        .clamp(1, MAX_PARALLEL_PROCESSES)
        .min(rules.len().max(1));
    let mut next_rule = 0;

    while next_rule < rules.len() {
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
    let mut new_findings = Vec::new();
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

#[cfg(test)]
mod tests {
    use super::{analyze, compiled_rules, extract_html_text, CompiledRule, RuleDefinition};
    use regex::Regex;

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
